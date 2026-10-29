"use strict";
/* The chat across two regions, against one pg-mem database. */

const { newDb } = require("pg-mem");
const { Chat, Throttle, clean, KEEP } = require("../server/chat");

let fails = 0;
const ok = (cond, what) => { console.log((cond ? "  ok   " : "  FAIL ") + what); if (!cond) fails++; };
const eq = (got, want, what) => ok(JSON.stringify(got) === JSON.stringify(want), what + "  (got " + JSON.stringify(got) + ")");
const settle = (ms) => new Promise(r => setTimeout(r, ms || 30));
const line = (mid, text, uid) => ({ mid, at: Date.now(), uid: uid || "u_a", who: "w" + (uid || "a"), name: "ana", color: "#00c7fd", text });

(async () => {
  const db = newDb({ noAstCoverageCheck: true });
  const pg = db.adapters.createPg();
  const region = async () => { const c = new Chat({ pool: new pg.Pool(), log: (...a) => console.log("   ", ...a) }); await c.start(); c.stop(); return c; };

  console.log("\ntext is cleaned");
  eq(clean("  hi‮ there \n\n  you\u0000 "), "hi there you", "control and direction characters out, spaces folded");
  eq(clean("x".repeat(500)).length, 200, "cut at 200");
  eq(clean("   "), "", "blank is nothing");

  console.log("\na line crosses the ocean");
  const fra = await region(), nyc = await region();
  const heard = [];
  nyc.onChange(c => heard.push(c));
  fra.say(line("m1", "hello from frankfurt"));
  await settle();
  await nyc.poll();
  eq(nyc.lines.map(l => l.text), ["hello from frankfurt"], "nyc has the line");
  eq(heard.length, 1, "nyc told its listeners once");
  await nyc.poll();
  eq(nyc.lines.length, 1, "a second poll does not repeat it");
  eq(Object.keys(nyc.view()[0]).sort(), ["at", "color", "mid", "name", "text", "who"], "the page never sees the account id");

  console.log("\nboth ways, in order");
  nyc.say(line("m2", "hello from new york", "u_b"));
  await settle();
  await fra.poll();
  eq(fra.lines.map(l => l.text), ["hello from frankfurt", "hello from new york"], "fra has both");
  eq(fra.lines[1].uid, "u_b", "the server keeps who said it, for a takedown");

  console.log("\na takedown reaches the other side");
  const gone = [];
  nyc.onChange(c => c.gone && gone.push(...c.gone));
  const taken = fra.remove("m2");
  eq(taken && taken.uid, "u_b", "fra knows whose line it took down");
  await settle();
  await nyc.poll();
  eq(nyc.lines.map(l => l.mid), ["m1"], "nyc dropped it");
  eq(gone, ["m2"], "and told its listeners");

  console.log("\na restart loads the history");
  const again = await region();
  eq(again.lines.map(l => l.mid), ["m1"], "the removed line stays removed");

  console.log("\nonly the last " + KEEP + " are held");
  for (let i = 0; i < KEEP + 15; i++) fra.say(line("k" + i, "line " + i));
  eq(fra.lines.length, KEEP, "held to " + KEEP);
  eq(fra.lines[KEEP - 1].text, "line " + (KEEP + 14), "newest last");

  console.log("\nwithout a database it is one server's chat");
  const solo = new Chat({ pool: null }); await solo.start();
  solo.say(line("s1", "just here"));
  eq(solo.lines.length, 1, "kept in memory");

  console.log("\nthe throttle: three at once, then one per two seconds");
  const t = new Throttle(3, 2000), t0 = 1e6;
  eq([t.take("u", t0), t.take("u", t0), t.take("u", t0), t.take("u", t0)], [true, true, true, false], "a burst of three");
  eq(t.take("u", t0 + 1000), false, "not after one second");
  eq(t.take("u", t0 + 2000), true, "one after two");
  eq(t.take("v", t0), true, "another player has their own");

  console.log(fails ? "\n" + fails + " FAILED" : "\nall good");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
