"use strict";
/* Two regions against one database, using pg-mem so the SQL actually runs. */

const { newDb } = require("pg-mem");
const { PgStore } = require("../server/pgstore");
const { Store, SplitStore, REGIONAL } = require("../server/store");

let fails = 0;
const ok = (cond, what) => {
  console.log((cond ? "  ok   " : "  FAIL ") + what);
  if (!cond) fails++;
};
const eq = (got, want, what) =>
  ok(JSON.stringify(got) === JSON.stringify(want), what + "  (got " + JSON.stringify(got) + ")");

const settle = (ms) => new Promise(r => setTimeout(r, ms || 30));

/* a pool that answers the way one across an ocean does */
const slow = (pool, ms) => ({
  query: (...a) => new Promise((res, rej) => setTimeout(() => pool.query(...a).then(res, rej), ms)),
  on: () => {}
});

(async () => {
  // pg-mem trips its own AST-coverage check on a second CREATE TABLE IF NOT
  // EXISTS; real Postgres is happy, and every region running the schema is the
  // point, so relax the harness rather than the code
  const db = newDb({ noAstCoverageCheck: true });
  const pg = db.adapters.createPg();
  const region = async (name) => {
    const s = new PgStore(new pg.Pool(), (...a) => console.log("   [" + name + "]", ...a));
    await s.start();
    return s;
  };

  console.log("\nschema and a round trip");
  const fra = await region("fra");
  fra.set("board/top", { rows: [{ who: "ana", best: 1200 }] });
  await settle();
  eq(fra.get("board/top"), { rows: [{ who: "ana", best: 1200 }] }, "reads back what it wrote");
  const raw = await new pg.Pool().query("SELECT path, v FROM docs");
  eq(raw.rows.length, 1, "one row reached the database");

  console.log("\na second region sees it");
  const nyc = await region("nyc");
  eq(nyc.get("board/top"), { rows: [{ who: "ana", best: 1200 }] }, "nyc loaded the board at boot");

  console.log("\nchanges cross the ocean");
  nyc.set("data/users/u_1/profile", { who: "bogdan", skin: "ring" });
  await settle();
  await fra.poll();
  eq(fra.get("data/users/u_1/profile"), { who: "bogdan", skin: "ring" }, "fra polled up nyc's profile");

  console.log("\ncoins: the database does the arithmetic");
  eq(fra.bump("wallets/u_1", "coins", 100), 100, "fra opens the wallet at 100");
  await settle();
  await nyc.poll();
  eq(nyc.get("wallets/u_1").coins, 100, "nyc sees 100");

  // both regions charge the same player at the same moment, each from its own
  // cached balance — the kind of thing a last-write-wins set would lose
  fra.bump("wallets/u_1", "coins", -10);
  nyc.bump("wallets/u_1", "coins", -10);
  await settle();
  const after = await new pg.Pool().query("SELECT coins FROM wallets WHERE uid = $1", ["u_1"]);
  eq(Number(after.rows[0].coins), 80, "both charges landed: 100 - 10 - 10 = 80");

  console.log("\na balance cannot go below zero");
  fra.bump("wallets/u_1", "coins", -500);
  await settle();
  const floor = await new pg.Pool().query("SELECT coins FROM wallets WHERE uid = $1", ["u_1"]);
  eq(Number(floor.rows[0].coins), 0, "clamped at 0 in the database, not just in memory");

  console.log("\ngems are their own column");
  fra.bump("wallets/u_1", "gems", 7);
  await settle();
  const g = await new pg.Pool().query("SELECT coins, gems FROM wallets WHERE uid = $1", ["u_1"]);
  eq([Number(g.rows[0].coins), Number(g.rows[0].gems)], [0, 7], "gems moved, coins did not");

  console.log("\nwhat belongs to a region stays there");
  const split = new SplitStore(new Store("/nonexistent/never-written.json"), fra);
  split.set("live/t1", { rid: "abc", startsAt: 1 });
  split.set("wallets/u_2", { coins: 50, gems: 0 });
  await settle();
  const leaked = await new pg.Pool().query("SELECT path FROM docs WHERE path LIKE 'live/%'");
  eq(leaked.rows.length, 0, "live/t1 never reached the shared database");
  eq(split.get("live/t1"), { rid: "abc", startsAt: 1 }, "but it is readable locally");
  const w2 = await new pg.Pool().query("SELECT coins FROM wallets WHERE uid = $1", ["u_2"]);
  eq(Number(w2.rows[0].coins), 50, "the wallet did reach it");
  ok(REGIONAL.test("locks/t1"), "leases are regional too");

  console.log("\na lease is never taken against the shared store");
  let threw = false;
  try { fra.acquire("locks/t1", "me", 1000); } catch (e) { threw = true; }
  ok(threw, "refuses rather than pretending to hold a cross-region lock");

  console.log("\ncharges that pile up while the database is answering");
  // The case that only appears once the database is a round trip away: three
  // charges issued inside one of them. A queue holding a single pending write
  // per path keeps the last and the middle one is never made - with pg-mem
  // answering instantly it never happens, so the pool here is slowed to look
  // like one across an ocean.
  const far = new PgStore(slow(new pg.Pool(), 40), () => {});
  await far.start();
  far.bump("wallets/u_5", "coins", 100);
  await settle(400);
  far.bump("wallets/u_5", "coins", -10);
  far.bump("wallets/u_5", "coins", -25);
  far.bump("wallets/u_5", "coins", -5);
  await settle(400);
  const piled = await new pg.Pool().query("SELECT coins FROM wallets WHERE uid = $1", ["u_5"]);
  eq(Number(piled.rows[0].coins), 60, "100 - 10 - 25 - 5, every charge made");

  console.log("\ndeletes propagate");
  fra.del("board/top");
  await settle();
  const gone = await new pg.Pool().query("SELECT path FROM docs WHERE path = 'board/top'");
  eq(gone.rows.length, 0, "removed from the database");

  console.log(fails ? "\n" + fails + " FAILED\n" : "\nall passed\n");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error("\ntest crashed:", e); process.exit(1); });
