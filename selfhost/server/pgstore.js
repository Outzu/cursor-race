"use strict";
/* The half of the store that every region shares.

   An account is an account wherever you play: the same coins, the same
   cursors, the same place on the board. A race is not - it belongs to the
   server running it, and nothing in here touches that. See store.js for the
   split, and index.js for which paths go where.

   The whole shared set is held in memory and served from there, because the
   rest of the server reads documents synchronously in the middle of a frame
   and must not wait on a query. Writes go to Postgres behind that, and a poll
   brings back what the other region changed. Coins are the exception: those
   are added up by the database itself, so two regions cannot lose a delta
   between reading a balance and writing it back. */

const WALLET = /^wallets\/(.+)$/;
const POLL_MS = Number(process.env.SHARED_POLL_MS || 3000);

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS docs (
     path text PRIMARY KEY,
     body jsonb NOT NULL,
     v    bigint NOT NULL DEFAULT 1,
     at   bigint NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS docs_at ON docs (at)`,
  `CREATE TABLE IF NOT EXISTS wallets (
     uid     text PRIMARY KEY,
     coins   bigint NOT NULL DEFAULT 0,
     gems    bigint NOT NULL DEFAULT 0,
     updated bigint NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS wallets_updated ON wallets (updated)`
];

class PgStore {
  constructor(pool, log) {
    this.pool = pool;
    this.log = log || (() => {});
    this.docs = {};            // path -> { body, v, at }
    this.subs = new Set();
    this.queue = new Map();    // path -> writes still to go out, in order
    this.flushing = false;
    this.seen = 0;             // newest `at` we have taken from the database
  }

  /* ---------- lifecycle ---------- */

  async start() {
    for (const sql of SCHEMA) await this.pool.query(sql);
    await this.reload();
    this.timer = setInterval(() => this.poll().catch(e => this.log("shared poll:", e.message)), POLL_MS);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  async reload() {
    const docs = await this.pool.query("SELECT path, body, v, at FROM docs");
    for (const r of docs.rows) this.take(r.path, r.body, Number(r.v), Number(r.at));
    const w = await this.pool.query("SELECT uid, coins, gems, updated FROM wallets");
    for (const r of w.rows) {
      this.take("wallets/" + r.uid,
        { coins: Number(r.coins), gems: Number(r.gems), updated: Number(r.updated) },
        1, Number(r.updated));
    }
    this.log("shared store: " + Object.keys(this.docs).length + " documents");
  }

  /* take a row from the database, unless what we hold is newer */
  take(path, body, v, at) {
    const have = this.docs[path];
    if (have && (have.v > v || have.at > at)) return false;
    this.docs[path] = { body, v, at };
    return true;
  }

  /* what the other region has changed since we last looked */
  async poll() {
    const since = this.seen;
    const docs = await this.pool.query("SELECT path, body, v, at FROM docs WHERE at > $1", [since]);
    const w = await this.pool.query("SELECT uid, coins, gems, updated FROM wallets WHERE updated > $1", [since]);
    let newest = since;
    const changed = [];
    for (const r of docs.rows) {
      newest = Math.max(newest, Number(r.at));
      if (this.queue.has(r.path)) continue;                  // our own write is still in flight
      if (this.take(r.path, r.body, Number(r.v), Number(r.at))) changed.push(r.path);
    }
    for (const r of w.rows) {
      newest = Math.max(newest, Number(r.updated));
      const path = "wallets/" + r.uid;
      if (this.queue.has(path)) continue;
      if (this.take(path, { coins: Number(r.coins), gems: Number(r.gems), updated: Number(r.updated) },
                    1, Number(r.updated))) changed.push(path);
    }
    this.seen = newest;
    for (const path of changed) this.fire(path);
  }

  /* ---------- the five methods the rest of the server knows ---------- */

  get(p) { const d = this.docs[p]; return d ? d.body : null; }
  version(p) { const d = this.docs[p]; return d ? d.v : 0; }
  list(prefix) { return Object.keys(this.docs).filter(k => k.startsWith(prefix)); }

  set(p, body) {
    const at = Date.now();
    const v = this.version(p) + 1;
    this.docs[p] = { body, v, at };
    this.enqueue(p, { kind: "set", body, v, at });
    this.fire(p);
  }

  update(p, patch) { this.set(p, Object.assign({}, this.get(p) || {}, patch)); }

  del(p) {
    delete this.docs[p];
    this.enqueue(p, { kind: "del" });
    this.fire(p);
  }

  /* A lease across two regions would need the database in the hot path, and
     the only thing leased is opening a race - which never leaves one region.
     If this is ever reached, say so rather than pretend to hold a lock. */
  acquire() {
    throw new Error("leases are regional; keep locks/ on the local store");
  }

  onChange(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }

  fire(p) {
    for (const fn of this.subs) {
      try { fn(p, this.get(p)); } catch (e) { this.log("shared subscriber:", e.message); }
    }
  }

  /* ---------- money ---------- */

  /* Add to a balance and let the database do the arithmetic, so a delta cannot
     be lost between reading a balance and writing it back. The cache moves
     straight away - the game cannot wait for a round trip mid-race - and is
     corrected from what the database returns. */
  bump(path, field, delta, floorAt0) {
    const m = WALLET.exec(path);
    if (!m) throw new Error("bump is for wallets, not " + path);
    const uid = m[1];
    const key = field === "gems" ? "gems" : "coins";
    const now = Date.now();

    const held = this.get(path) || { coins: 0, gems: 0 };
    const next = Object.assign({}, held, { updated: now });
    next[key] = floorAt0 === false ? held[key] + delta : Math.max(0, held[key] + delta);
    this.docs[path] = { body: next, v: this.version(path) + 1, at: now };
    this.fire(path);

    this.enqueue(path, { kind: "bump", uid, key, delta, at: now, seed: held });
    return next[key];
  }

  /* ---------- writing it down ----------

     Queued per path and in order. Consecutive whole-document writes collapse
     into the last one, because that is what the document will say anyway - but
     a balance change is a delta, not a statement of fact, and collapsing one
     into a neighbouring write would quietly spend or mint coins. */
  enqueue(path, job) {
    const list = this.queue.get(path);
    if (!list) { this.queue.set(path, [job]); }
    else if (job.kind === "set" && list[list.length - 1].kind === "set") list[list.length - 1] = job;
    else list.push(job);
    this.kick();
  }

  kick() { if (!this.flushing) this.flush().catch(e => this.log("shared flush:", e.message)); }

  async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.size) {
        const [path, list] = this.queue.entries().next().value;
        this.queue.delete(path);
        for (const job of list) {
          try {
            await this.write(path, job);
          } catch (e) {
            this.log("shared write failed for " + path + ": " + e.message);
          }
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  async write(path, job) {
    const m = WALLET.exec(path);

    if (job.kind === "bump") {
      await this.pool.query(
        `INSERT INTO wallets (uid, coins, gems, updated) VALUES ($1, $2, $3, $4)
         ON CONFLICT (uid) DO NOTHING`,
        [job.uid, job.seed.coins || 0, job.seed.gems || 0, job.at]);
      const col = job.key === "gems" ? "gems" : "coins";
      const r = await this.pool.query(
        `UPDATE wallets SET ${col} = GREATEST(0, ${col} + $1), updated = $2
         WHERE uid = $3 RETURNING coins, gems, updated`,
        [job.delta, job.at, job.uid]);
      if (r.rows.length) {
        const row = r.rows[0];
        const truth = { coins: Number(row.coins), gems: Number(row.gems), updated: Number(row.updated) };
        const have = this.docs[path];
        // the database is the ledger; take its figures, keeping our version
        this.docs[path] = { body: truth, v: have ? have.v : 1, at: truth.updated };
        this.seen = Math.max(this.seen, truth.updated);
        this.fire(path);
      }
      return;
    }

    if (job.kind === "del") {
      if (m) await this.pool.query("DELETE FROM wallets WHERE uid = $1", [m[1]]);
      else await this.pool.query("DELETE FROM docs WHERE path = $1", [path]);
      return;
    }

    if (m) {
      const b = job.body || {};
      await this.pool.query(
        `INSERT INTO wallets (uid, coins, gems, updated) VALUES ($1, $2, $3, $4)
         ON CONFLICT (uid) DO UPDATE SET coins = $2, gems = $3, updated = $4`,
        [m[1], Math.round(b.coins || 0), Math.round(b.gems || 0), job.at]);
      this.seen = Math.max(this.seen, job.at);
      return;
    }

    await this.pool.query(
      `INSERT INTO docs (path, body, v, at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (path) DO UPDATE SET body = $2, v = $3, at = $4`,
      [path, JSON.stringify(job.body), job.v, job.at]);
    this.seen = Math.max(this.seen, job.at);
  }
}

module.exports = { PgStore, SCHEMA };
