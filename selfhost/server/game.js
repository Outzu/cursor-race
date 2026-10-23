"use strict";
/* Rules the server has to agree with the client about. Keep these in step with
   the matching constants in game/cursor-race.html. */

const W = 800, H = 1000;
const V0 = 150, TA = 22, VMAX = 760;
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

module.exports = {
  W, H, distAt, maxDistAt,
  JOIN_WINDOW: Number(process.env.JOIN_WINDOW || 30000),
  ENTRY_FEE: Number(process.env.ENTRY_FEE || 10),
  START_CREDITS: Number(process.env.START_CREDITS || 100),
  RESULT_HOLD: Number(process.env.RESULT_HOLD || 9000),
  TABLE_CAP: Number(process.env.TABLE_CAP || 10),
  STAKES: [5, 10, 25]
};
