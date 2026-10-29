"use strict";
/* Rules the server has to agree with the client about. Keep these in step with
   the matching constants in game/cursor-race.html. */

const W = 800, H = 1000;
const V0 = 200, TA = 22, VMAX = 760;
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
  arrow: 0, ace: 0, ring: 300, dot: 700, cross: 1300, blade: 2200, glow: 3500,
  comet: 5200, prism: 7500, halo: 10500, spectrum: 14500, bullion: 19500,
  kamish: 25500, azure: 32500, mcsword: 40000,
  phoenix: 49000, eclipse: 60000 };
const TAIL_COST = { none: 0, wisp: 0, suits: 0, flare: 150, bubble: 300, snowflake: 550, gold: 900,
  rainbow2: 1400, ember: 2000, fairydust: 2800, petals: 3800, sparks: 5000, confetti: 6500, volt: 8500,
  canvas: 11500, galaxy: 15000, smoke: 19500, rainbow: 25000 };
const GROUND_COST = {
  plain: 0, meadow: 2000, atlas: 6000, neon: 14000, streets: 25000
};
// what steering sounds like; paid in gems, like tails
const SOUND_COST = { quiet: 0, swish: 250, skid: 800, jet: 2000, plasma: 4500, laser: 8000 };

module.exports = {
  W, H, distAt, maxDistAt, SKIN_COST, TAIL_COST, GROUND_COST, SOUND_COST,
  JOIN_WINDOW: Number(process.env.JOIN_WINDOW || 30000),
  ENTRY_FEE: Number(process.env.ENTRY_FEE || 10),
  START_COINS: Number(process.env.START_COINS || 100),
  RESULT_HOLD: Number(process.env.RESULT_HOLD || 9000),
  TABLE_CAP: Number(process.env.TABLE_CAP || 10)
};
