"use strict";
/* The page and the server each carry a price list, and the server's is the
   one that actually takes the money. They drifted once - tails went up
   tenfold on the page while the server kept charging the old prices, and two
   cursors swapped places without the server hearing - so this reads the
   prices straight out of the game file and refuses to let them differ. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const G = require("../server/game");

const page = fs.readFileSync(path.join(__dirname, "..", "game", "cursor-race.html"), "utf8");

// every item on the page, in the order it is declared: skins, then tails, then grounds
function listed() {
  const out = [];
  const re = /id: "([a-z0-9]+)", name: "[^"]+", cost: (\d+)/g;
  let m;
  while ((m = re.exec(page))) out.push({ id: m[1], cost: Number(m[2]) });
  return out;
}

test("the server charges what the page shows", () => {
  const onPage = listed();
  assert.ok(onPage.length > 20, "found the catalogue on the page");
  const tables = { skins: G.SKIN_COST, tails: G.TAIL_COST, grounds: G.GROUND_COST };
  for (const { id, cost } of onPage) {
    const where = Object.entries(tables).filter(([, t]) => id in t);
    assert.equal(where.length, 1, id + " is priced in exactly one server table");
    const [kind, table] = where[0];
    assert.equal(table[id], cost, id + " (" + kind + ") costs " + cost + " on the page");
  }
  // and nothing the server would charge for is missing from the page
  const ids = new Set(onPage.map(x => x.id));
  for (const [kind, table] of Object.entries(tables))
    for (const id of Object.keys(table)) assert.ok(ids.has(id), kind + "/" + id + " is on the page");
});
