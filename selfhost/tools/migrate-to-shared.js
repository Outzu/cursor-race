"use strict";
/* Move the accounts out of the JSON file and into the shared database.

   Run this once, on the server that already has players, before you ever set
   DATABASE_URL on it. The moment that variable is set, wallets, accounts,
   profiles and the board are read from Postgres instead of the file - and an
   empty database means every player appears to be new, is handed a fresh
   hundred coins, and loses whatever they had bought. This is what stands
   between the two.

   Races are not copied. live/ and locks/ belong to the server running them.

   Usage:
     DATABASE_URL=postgres://... node tools/migrate-to-shared.js /var/lib/cursor-race/store.json
     ... --go        actually write; without it this only reports
     ... --force     overwrite rows already in the database
*/

const fs = require("fs");
const { Pool } = require("pg");
const { SCHEMA, pgConfig } = require("../server/pgstore");
const { REGIONAL } = require("../server/store");

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith("--"));
const go = args.includes("--go");
const force = args.includes("--force");

if (!file || !process.env.DATABASE_URL) {
  console.error("usage: DATABASE_URL=postgres://... node tools/migrate-to-shared.js <store.json> [--go] [--force]");
  process.exit(2);
}

const WALLET = /^wallets\/(.+)$/;

async function main() {
  const docs = JSON.parse(fs.readFileSync(file, "utf8"));
  const paths = Object.keys(docs);

  const skipped = paths.filter(p => REGIONAL.test(p));
  const moving = paths.filter(p => !REGIONAL.test(p));
  const wallets = moving.filter(p => WALLET.test(p));

  console.log("%s holds %d documents", file, paths.length);
  console.log("  %d to move  (%d wallets, %d everything else)",
    moving.length, wallets.length, moving.length - wallets.length);
  console.log("  %d left behind, because a race belongs to its own server", skipped.length);

  let coins = 0, gems = 0;
  for (const p of wallets) {
    const b = (docs[p] || {}).body || {};
    coins += Math.round(b.coins || 0);
    gems += Math.round(b.gems || 0);
  }
  console.log("  carrying %d coins and %d gems between them", coins, gems);

  if (!go) {
    console.log("\nnothing written. Pass --go when this looks right.");
    return;
  }

  const pool = new Pool(pgConfig(process.env.DATABASE_URL));
  for (const sql of SCHEMA) await pool.query(sql);

  let wrote = 0, left = 0;
  for (const p of moving) {
    const d = docs[p] || {};
    const body = d.body;
    if (body === undefined || body === null) continue;
    const at = Number(d.at) || Date.now();
    const v = Number(d.v) || 1;
    const m = WALLET.exec(p);

    if (m) {
      const r = await pool.query(
        force
          ? `INSERT INTO wallets (uid, coins, gems, updated) VALUES ($1,$2,$3,$4)
             ON CONFLICT (uid) DO UPDATE SET coins = $2, gems = $3, updated = $4`
          : `INSERT INTO wallets (uid, coins, gems, updated) VALUES ($1,$2,$3,$4)
             ON CONFLICT (uid) DO NOTHING`,
        [m[1], Math.round(body.coins || 0), Math.round(body.gems || 0), at]);
      if (r.rowCount) wrote++; else left++;
      continue;
    }

    const r = await pool.query(
      force
        ? `INSERT INTO docs (path, body, v, at) VALUES ($1,$2,$3,$4)
           ON CONFLICT (path) DO UPDATE SET body = $2, v = $3, at = $4`
        : `INSERT INTO docs (path, body, v, at) VALUES ($1,$2,$3,$4)
           ON CONFLICT (path) DO NOTHING`,
      [p, JSON.stringify(body), v, at]);
    if (r.rowCount) wrote++; else left++;
  }

  const w = await pool.query("SELECT count(*)::int n, coalesce(sum(coins),0)::bigint c FROM wallets");
  const dd = await pool.query("SELECT count(*)::int n FROM docs");
  console.log("\nwrote %d, left %d alone%s", wrote, left, force ? "" : " (already there; --force to overwrite)");
  console.log("database now holds %d wallets with %s coins, and %d other documents",
    w.rows[0].n, String(w.rows[0].c), dd.rows[0].n);
  await pool.end();
}

main().catch(e => { console.error("migration failed:", e.message); process.exit(1); });
