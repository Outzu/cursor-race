"use strict";
/* The chat on the home screen.

   One conversation for everyone, whichever server they landed on. Lines are
   kept in memory - the last sixty are all the page ever shows - and, where
   there is a shared database, written to a table of their own and read back
   by the other region every second and a half. That is the only thing chat
   asks of Postgres: one insert per line said and one small query per poll.

   Nothing here is on the race's path. A player racing is not sent chat at all
   (the page stops listening at the gate and picks up the history afterwards),
   and a line is encoded once and the same bytes go to everyone listening. */

const KEEP = 60;                       // lines held and shown
const MAX_LEN = 200;                   // characters a line may hold
const POLL_MS = Number(process.env.CHAT_POLL_MS || 1500);
const KEEP_DAYS = 7;                   // rows older than this are swept from the table

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS chat (
     seq   bigserial PRIMARY KEY,
     mid   text NOT NULL UNIQUE,
     at    bigint NOT NULL,
     kind  text NOT NULL DEFAULT 'say',
     uid   text NOT NULL DEFAULT '',
     who   text NOT NULL DEFAULT '',
     name  text NOT NULL DEFAULT '',
     color text NOT NULL DEFAULT '',
     body  text NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS chat_at ON chat (at)`
];

/* What may be said: printable text on one line. Control characters, the
   invisible direction overrides that can make a line read backwards, and
   zero-width characters are taken out; runs of space become one. */
function clean(text) {
  return Array.from(String(text == null ? "" : text)
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g, " ")
    .replace(/\s+/g, " ")
    .trim()).slice(0, MAX_LEN).join("");
}

class Chat {
  constructor(opts) {
    this.pool = opts.pool || null;
    this.log = opts.log || (() => {});
    this.lines = [];                 // { mid, at, uid, who, name, color, text }, oldest first
    this.known = new Set();          // every mid seen, said or removed, so nothing arrives twice
    this.subs = new Set();
    this.lastSeq = 0;
  }

  async start() {
    if (!this.pool) return this;
    for (const sql of SCHEMA) await this.pool.query(sql);
    const r = await this.pool.query("SELECT seq, mid, at, kind, uid, who, name, color, body FROM chat ORDER BY seq DESC LIMIT 400");
    this.take(r.rows.reverse(), false);
    this.timer = setInterval(() => this.poll().catch(e => this.log("chat poll:", e.message)), POLL_MS);
    if (this.timer.unref) this.timer.unref();
    this.sweeper = setInterval(() => {
      this.pool.query("DELETE FROM chat WHERE at < $1", [Date.now() - KEEP_DAYS * 86400000])
        .catch(e => this.log("chat sweep:", e.message));
    }, 3600000);
    if (this.sweeper.unref) this.sweeper.unref();
    this.log("chat: " + this.lines.length + " lines kept");
    return this;
  }

  stop() { clearInterval(this.timer); clearInterval(this.sweeper); }

  /* What the other region said since the last look. Sequence numbers are
     handed out when a row is inserted but can become visible out of order,
     so each poll looks a little way back and lets `known` drop the repeats. */
  async poll() {
    const r = await this.pool.query(
      "SELECT seq, mid, at, kind, uid, who, name, color, body FROM chat WHERE seq > $1 ORDER BY seq LIMIT 500",
      [Math.max(0, this.lastSeq - 50)]);
    this.take(r.rows, true);
  }

  take(rows, tell) {
    const add = [], gone = [];
    for (const row of rows) {
      this.lastSeq = Math.max(this.lastSeq, Number(row.seq) || 0);
      if (this.known.has(row.mid)) continue;
      this.known.add(row.mid);
      if (row.kind === "del") { if (this.drop(row.body)) gone.push(row.body); continue; }
      if (row.kind !== "say") continue;
      const line = { mid: row.mid, at: Number(row.at), uid: row.uid, who: row.who,
                     name: row.name, color: row.color, text: row.body };
      this.push(line);
      add.push(line);
    }
    if (this.known.size > 5000) this.known = new Set([...this.known].slice(-2000));
    if (tell && add.length) this.fire({ add });
    if (tell && gone.length) this.fire({ gone });
  }

  push(line) {
    this.lines.push(line);
    if (this.lines.length > KEEP) this.lines.splice(0, this.lines.length - KEEP);
  }
  drop(mid) {
    const i = this.lines.findIndex(l => l.mid === mid);
    if (i < 0) return false;
    this.lines.splice(i, 1);
    return true;
  }

  /* a line said here: shown here at once, and written for the other region */
  say(line) {
    this.known.add(line.mid);
    this.push(line);
    this.fire({ add: [line] });
    this.write("say", line.mid, line.at, line.uid, line.who, line.name, line.color, line.text);
  }

  /* a line taken down, everywhere */
  remove(mid) {
    const line = this.lines.find(l => l.mid === mid) || null;
    if (!line) return null;
    this.drop(mid);
    this.fire({ gone: [mid] });
    const id = "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    this.known.add(id);
    this.write("del", id, Date.now(), "", "", "", "", mid);
    return line;
  }

  write(kind, mid, at, uid, who, name, color, body) {
    if (!this.pool) return;
    this.pool.query(
      "INSERT INTO chat (mid, at, kind, uid, who, name, color, body) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [mid, at, kind, uid, who, name, color, body])
      .catch(e => this.log("chat write:", e.message));
  }

  /* the lines as the page sees them: no account ids, only the short `who` */
  view(lines) {
    return (lines || this.lines).map(l => ({ mid: l.mid, at: l.at, who: l.who, name: l.name, color: l.color, text: l.text }));
  }

  onChange(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  fire(change) {
    for (const fn of this.subs) {
      try { fn(change); } catch (e) { this.log("chat subscriber:", e.message); }
    }
  }
}

/* How often one player may speak: three lines at once, then one every two
   seconds. A flood is the one way chat could cost a race anything, so the
   bucket is held per account, not per tab. */
class Throttle {
  constructor(burst, everyMs) { this.burst = burst; this.every = everyMs; this.held = new Map(); }
  take(key, now) {
    const b = this.held.get(key) || { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + (now - b.at) / this.every);
    b.at = now;
    if (b.tokens < 1) { this.held.set(key, b); return false; }
    b.tokens -= 1;
    this.held.set(key, b);
    if (this.held.size > 5000) {
      for (const [k, v] of this.held) if (now - v.at > 60000) this.held.delete(k);
    }
    return true;
  }
}

module.exports = { Chat, Throttle, clean, MAX_LEN, KEEP };
