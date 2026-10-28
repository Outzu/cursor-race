"use strict";
/* Rules the server has to agree with the client about. Keep these in step with
   the matching constants in game/cursor-race.html. */

const W = 800, H = 1000;
const V0 = 200, TA = 28, VMAX = 700;
const T_CAP = TA * (VMAX / V0 - 1);

/* how far the channel has scrolled t seconds after the gate opens */
function distAt(t) {
  if (t <= 0) return 0;
  if (t <= T_CAP) return V0 * (t + (t * t) / (2 * TA));
  const dc = V0 * (T_CAP + (T_CAP * T_CAP) / (2 * TA));
  return dc + VMAX * (t - T_CAP);
}

/* the furthest a run can honestly claim at this moment, with a little slack for
   clock skew and network lag */
function maxDistAt(startedAt, now) {
  return distAt((now - startedAt) / 1000) * 1.02 + 60;
}

/* Prices, mirroring the game file. The server charges for anything a player
   newly owns, so these have to agree with the page - and for a while they did
   not: tails went up tenfold on the page and Arrow and Dot swapped places,
   and this table kept charging the old numbers underneath. test/prices.test.js
   now reads the page and fails if the two ever drift again. */
const SKIN_COST = {
  arrow: 0, ring: 40, dot: 90, cross: 160, blade: 260, glow: 400,
  comet: 560, prism: 760, halo: 1000, spectrum: 1300, bullion: 1700,
  kamish: 2000, azure: 2400, mcsword: 2800,
  phoenix: 3200, eclipse: 3600 };
const TAIL_COST = { none: 0, wisp: 0, flare: 80, bubble: 120, snowflake: 180, gold: 220,
  rainbow2: 260, ember: 300, fairydust: 350, petals: 400, sparks: 450, confetti: 480, volt: 520,
  canvas: 600, galaxy: 650, smoke: 700, rainbow: 900 };
const GROUND_COST = {
  plain: 0, meadow: 300, atlas: 800, neon: 1500, streets: 2500
};

module.exports = {
  W, H, distAt, maxDistAt, SKIN_COST, TAIL_COST, GROUND_COST,
  JOIN_WINDOW: Number(process.env.JOIN_WINDOW || 30000),
  ENTRY_FEE: Number(process.env.ENTRY_FEE || 10),
  START_COINS: Number(process.env.START_COINS || 100),
  RESULT_HOLD: Number(process.env.RESULT_HOLD || 9000),
  TABLE_CAP: Number(process.env.TABLE_CAP || 10)
};
