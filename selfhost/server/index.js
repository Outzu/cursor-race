"use strict";
/* Cursor Race self-hosted server.

   Serves the game and stands in for the three claude.ai runtime services the
   page expects: a presence room, a document store and an identity. The wallet
   and the race clock are the server's, not the client's. */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { attach } = require("./ws");
const { Store } = require("./store");
const G = require("./game");
const google = require("./google");

const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const PORT = Number(process.env.PORT || 8080);
const DATA = process.env.DATA_FILE || path.join(ROOT, "data", "store.json");

/* ---------- identity ---------- */
const SECRET_FILE = path.join(path.dirname(DATA), "secret");
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  try { return fs.readFileSync(SECRET_FILE, "utf8"); } catch (e) {}
  const s = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
    fs.writeFileSync(SECRET_FILE, s);
  } catch (e) { console.error("could not persist session secret:", e.message); }
  return s;
}
const SECRET = loadSecret();

const sign = v => v + "." + crypto.createHmac("sha256", SECRET).update(v).digest("hex").slice(0, 24);
function verify(token) {
  if (!token) return null;
  const i = token.lastIndexOf(".");
  if (i < 1) return null;
  const v = token.slice(0, i);
  return sign(v) === token ? v : null;
}
const newUid = () => "u_" + crypto.randomBytes(16).toString("base64url").slice(0, 22);
function cookieOf(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

const store = new Store(DATA);

/* ---------- the purse ----------
   The server holds the only copy. Clients report what they earned on a run and
   what they now own; every figure they are shown comes back from here. An
   earlier design had the page and the server each applying the same entry fee,
   which charged it twice. */
function purse(uid) {
  const w = store.get("wallets/" + uid);
  if (w && typeof w.coins === "number") {
    return { coins: w.coins, gems: typeof w.gems === "number" ? w.gems : 0 };
  }
  const fresh = { coins: G.START_COINS, gems: 0, created: Date.now() };
  store.set("wallets/" + uid, fresh);
  return { coins: fresh.coins, gems: fresh.gems };
}
const balance = uid => purse(uid).coins;

function move(uid, delta, why, what) {
  const p = purse(uid);
  const key = what === "gems" ? "gems" : "coins";
  p[key] = Math.max(0, Math.round(p[key] + delta));
  store.set("wallets/" + uid, { coins: p.coins, gems: p.gems, updated: Date.now() });
  if (delta) {
    console.log("  purse %s %s%d %s -> %d (%s)",
      uid.slice(0, 10), delta > 0 ? "+" : "", delta, key, p[key], why);
  }
  return p[key];
}

/* What a player now owns that they did not before, and what it costs. */
function chargeForNewGear(uid, wanted, held) {
  const list = (o, k) => (o && Array.isArray(o[k]) ? o[k] : []);
  let coins = 0, gems = 0;
  const addedSkins = list(wanted, "skins").filter(id => !list(held, "skins").includes(id));
  const addedTails = list(wanted, "tails").filter(id => !list(held, "tails").includes(id));
  for (const id of addedSkins) coins += G.SKIN_COST[id] || 0;
  for (const id of addedTails) gems += G.TAIL_COST[id] || 0;
  if (!coins && !gems) return true;
  const p = purse(uid);
  if (p.coins < coins || p.gems < gems) return false;
  if (coins) move(uid, -coins, "bought " + addedSkins.join(","), "coins");
  if (gems) move(uid, -gems, "bought " + addedTails.join(","), "gems");
  return true;
}

/* ---------- the room ---------- */
const peers = new Map();       // peerId -> { conn, uid, presence, rooms: Map(name -> presence) }
const rooms = new Map();       // room name -> Set(peerId)
const watchers = new Map();    // docPath -> Set(peerId)

function peerList() {
  const out = [];
  for (const [peer, p] of peers) out.push({ peer, uid: p.uid, presence: p.presence || {} });
  return out;
}
function roomList(name) {
  const set = rooms.get(name);
  const out = [];
  if (!set) return out;
  for (const peer of set) {
    const p = peers.get(peer);
    if (p) out.push({ peer, uid: p.uid, presence: p.rooms.get(name) || {} });
  }
  return out;
}

/* Rosters are coalesced onto a timer: presence is the hot path, and a 10-player
   table at 20 updates a second would otherwise be 200 broadcasts a second. */
let lobbyDirty = false;
const dirtyRooms = new Set();
function broadcastPeers() { lobbyDirty = true; }
function broadcastRoom(name) { dirtyRooms.add(name); }
setInterval(() => {
  if (lobbyDirty) {
    lobbyDirty = false;
    const msg = JSON.stringify({ type: "peers", peers: peerList() });
    for (const p of peers.values()) p.conn.send(msg);
  }
  for (const name of dirtyRooms) {
    const set = rooms.get(name);
    if (!set || !set.size) continue;
    const msg = JSON.stringify({ type: "peers", room: name, peers: roomList(name) });
    for (const peer of set) {
      const p = peers.get(peer);
      if (p) p.conn.send(msg);
    }
  }
  dirtyRooms.clear();
}, 40);   // a touch tighter than the 50ms the page pushes at, so nothing waits

function joinRoom(peerId, name) {
  let set = rooms.get(name);
  if (!set) { set = new Set(); rooms.set(name, set); }
  // the cap counts players, not tabs — a second tab of someone already seated
  // takes no extra seat
  if (!set.has(peerId)) {
    const me = peers.get(peerId);
    const seated = new Set();
    for (const id of set) {
      const p = peers.get(id);
      if (p) seated.add(p.uid);
    }
    if (!(me && seated.has(me.uid)) && seated.size >= G.TABLE_CAP) return "limit_reached";
  }
  set.add(peerId);
  const p = peers.get(peerId);
  if (p && !p.rooms.has(name)) p.rooms.set(name, {});
  broadcastRoom(name);
  return null;
}
function leaveRoom(peerId, name) {
  const set = rooms.get(name);
  if (set) {
    set.delete(peerId);
    if (!set.size) rooms.delete(name);
    broadcastRoom(name);
  }
  const p = peers.get(peerId);
  if (p) p.rooms.delete(name);
}

function pushDoc(docPath) {
  const set = watchers.get(docPath);
  if (!set || !set.size) return;
  for (const peer of set) {
    const p = peers.get(peer);
    if (!p) continue;
    p.conn.json({ type: "doc", path: docPath, data: readFor(p.uid, docPath), version: store.version(docPath) });
  }
}
store.onChange(pushDoc);

/* ---------- document policy ---------- */
function readFor(uid, p) {
  const body = store.get(p);
  const m = /^data\/users\/([^/]+)\/profile$/.exec(p);
  if (m) {
    if (m[1] !== uid) return null;                       // another player's drawer
    // `ledger` tells the page that money moves here, not in the browser
    const w = purse(uid);
    return Object.assign({}, body || {}, { coins: w.coins, gems: w.gems, ledger: true });
  }
  if (p.startsWith("wallets/") || p.startsWith("identities/")) return null;
  const u = /^users\/([^/]+)$/.exec(p);
  if (u) return u[1] === uid ? body : null;              // your own account only
  return body;
}

function writeFor(uid, p, data, mode) {
  if (!data || typeof data !== "object") return "invalid_argument";

  const t = /^live\/([a-z0-9]{1,8})$/.exec(p);
  if (t) {
    const table = t[1];
    const rid = typeof data.rid === "string" ? data.rid.slice(0, 16) : "";
    const r = rounds.get(table);
    const live = r && !r.settled && Date.now() < r.startsAt + 180000;
    if (!rid) {                                          // clearing the board
      if (live) return "not_permitted";
      store.set(p, { rid: "", startsAt: 0, serverNow: Date.now(), host: "" });
      rounds.delete(table);
      return null;
    }
    if (live) return "not_permitted";
    if (balance(uid) < G.ENTRY_FEE) return "not_permitted";
    openRound(table, rid, uid);
    return null;
  }
  if (/^live\//.test(p)) return "not_permitted";

  if (p === "board/top") {
    if (!store.get("users/" + uid)) return "not_permitted";     // signed-in players only
    const rows = (Array.isArray(data.rows) ? data.rows : [])
      .filter(r => r && typeof r.uid === "string" && typeof r.best === "number" && isFinite(r.best))
      .map(r => ({
        uid: r.uid.slice(0, 40),
        name: String(r.name || "pilot").slice(0, 14),
        best: Math.max(0, Math.round(r.best))
      }))
      .sort((a, b) => b.best - a.best)
      .slice(0, 10);
    store.set(p, { rows, updated: Date.now() });
    return null;
  }
  if (p.startsWith("board/")) return "not_permitted";

  const m = /^data\/users\/([^/]+)\//.exec(p);
  if (m) {
    if (m[1] !== uid) return "not_permitted";
    const clean = Object.assign({}, data);
    // money is the server's alone: the page may report what it earned on a run
    // and what it wants to own, never a balance
    delete clean.ledger;
    delete clean.coins;
    delete clean.gems;
    const stored = store.get(p) || {};
    if (clean.owned) {
      // only a signed-in account may acquire, and only if it can pay
      if (!store.get("users/" + uid) || !chargeForNewGear(uid, clean.owned, stored.owned)) {
        if (stored.owned) clean.owned = stored.owned; else delete clean.owned;
      }
    }
    if (mode === "update") store.update(p, clean); else store.set(p, clean);
    return null;
  }

  if (p.startsWith("wallets/") || p.startsWith("results/") ||
      p.startsWith("users/") || p.startsWith("identities/")) return "not_permitted";
  if (mode === "update") store.update(p, data); else store.set(p, data);
  return null;
}

/* ---------- the race ---------- */
const rounds = new Map();   // table id -> round

function openRound(table, rid, host) {
  const now = Date.now();
  const r = {
    table, rid, host, settled: false,
    startsAt: now + G.JOIN_WINDOW,
    entrants: new Map(),   // uid -> { peer, name, dist, state, paid }
    bets: new Map()        // uid -> { on, amt, paid }
  };
  rounds.set(table, r);
  store.set("live/" + table, { rid, startsAt: r.startsAt, serverNow: now, host, gate: G.JOIN_WINDOW });
  console.log("%s: race %s opens, gate shuts in %ds", table, rid, G.JOIN_WINDOW / 1000);
}

/* Presence is the only thing the clients report, so the ledger reads it:
   a seat is charged the first time a player claims one, a bet when it appears. */
function ledger(uid, pres, peerId, table) {
  const r = rounds.get(table);
  if (!r || !pres || pres.rid !== r.rid) return;

  if (pres.joined === true) {
    let e = r.entrants.get(uid);
    if (!e) {
      if (Date.now() > r.startsAt + 500) return;             // gate already shut
      if (balance(uid) < G.ENTRY_FEE) return;                 // cannot afford a seat
      e = { peer: peerId, name: String(pres.who || "pilot").slice(0, 14), dist: 0, state: "ready", paid: true };
      r.entrants.set(uid, e);
      move(uid, -G.ENTRY_FEE, "entry " + r.rid);
    }
    e.peer = peerId;
    e.name = String(pres.who || "pilot").slice(0, 14);
    e.state = String(pres.state || "out");
    const claimed = Number(pres.dist) || 0;
    e.dist = Math.max(e.dist, Math.min(claimed, G.maxDistAt(r.startsAt, Date.now())));
    e.rc = Math.max(e.rc || 0, Number(pres.rc) || 0);   // gates cleared, as reported
    e.rg = Math.max(e.rg || 0, Number(pres.rg) || 0);   // gems taken
    return;
  }

  const bet = pres.bet;
  if (bet && typeof bet.on === "string" && !r.bets.has(uid)) {
    const amt = Math.round(Number(bet.amt) || 0);
    if (!G.STAKES.includes(amt)) return;
    if (balance(uid) < amt) return;
    if (r.settled) return;
    // resolve the backed tab to a player now, while that peer is still around,
    // so a second tab of your own cannot be backed and cannot pay you out
    const target = peers.get(bet.on);
    const onUid = target ? target.uid : null;
    if (!onUid || onUid === uid) return;
    r.bets.set(uid, { on: bet.on, onUid, amt, paid: true });
    move(uid, -amt, "bet " + r.rid);
  }
}

function settle(r) {
  r.settled = true;
  const list = [...r.entrants.entries()].map(([uid, e]) => Object.assign({ uid }, e));
  const racing = list.filter(e => e.state === "racing");
  const winner = racing.length === 1 ? racing[0] : list.slice().sort((a, b) => b.dist - a.dist)[0];
  const pot = list.length * G.ENTRY_FEE;

  for (const e of list) {
    const span = G.maxDistAt(r.startsAt, Date.now());
    const coinCap = Math.max(0, Math.floor((span + G.H) / 520) + 1);
    const gemCap = Math.ceil(span / 700) + 2;
    const rc = Math.min(Math.max(0, Math.round(e.rc || 0)), coinCap);
    const rg = Math.min(Math.max(0, Math.round(e.rg || 0)), gemCap);
    if (rc) move(e.uid, rc, "gates " + r.rid, "coins");
    if (rg) move(e.uid, rg, "gems " + r.rid, "gems");
  }
  if (winner) move(winner.uid, pot, "pot " + r.rid);
  for (const [uid, b] of r.bets) {
    if (winner && b.onUid === winner.uid) move(uid, b.amt * list.length, "bet won " + r.rid);
  }

  store.set("results/" + r.rid, {
    rid: r.rid, table: r.table, at: Date.now(), pot,
    winner: winner ? { uid: winner.uid, name: winner.name, dist: Math.round(winner.dist) } : null,
    field: list.map(e => ({ name: e.name, dist: Math.round(e.dist) })),
    bets: [...r.bets.values()].map(b => ({ amt: b.amt, won: !!(winner && b.onUid === winner.uid) }))
  });
  console.log("%s: race %s won by %s, pot %d", r.table, r.rid, winner ? winner.name : "nobody", pot);

  setTimeout(() => {
    if (rounds.get(r.table) === r) {
      store.set("live/" + r.table, { rid: "", startsAt: 0, serverNow: Date.now(), host: "" });
      rounds.delete(r.table);
    }
  }, G.RESULT_HOLD);
}

function clearRound(r, now) {
  store.set("live/" + r.table, { rid: "", startsAt: 0, serverNow: now, host: "" });
  rounds.delete(r.table);
}

setInterval(() => {
  const now = Date.now();
  for (const r of [...rounds.values()]) {
    if (r.settled || now < r.startsAt) continue;

    /* A race needs someone to race: if nobody else confirmed by the time the
       gate shuts, call it off and hand the money back. Nothing else about the
       round is decided until this has been asked, or a lone pilot who clipped a
       wall on the first frame would be settled as the winner of their own pot. */
    if (!r.checked) {
      if (now < r.startsAt + 700) continue;      // seats are still accepted to +500
      r.checked = true;
      if (r.entrants.size < 2) {
        for (const [uid, e] of r.entrants) if (e.paid) move(uid, G.ENTRY_FEE, "refund " + r.rid);
        for (const [uid, b] of r.bets) if (b.paid) move(uid, b.amt, "refund bet " + r.rid);
        r.settled = true;
        rounds.delete(r.table);
        store.set("live/" + r.table, { rid: "", cancelled: true, serverNow: now, host: "" });
        console.log("%s: race %s called off, nobody else took a seat", r.table, r.rid);
        continue;
      }
    }

    const list = [...r.entrants.values()];
    if (!list.length) {
      if (now > r.startsAt + 5000) clearRound(r, now);
      continue;
    }
    if (list.some(e => e.state === "ready")) {
      if (now < r.startsAt + 4000) continue;             // give slow clients a moment
      for (const e of list) if (e.state === "ready") e.state = "out";
    }
    const racing = list.filter(e => e.state === "racing");
    if (racing.length === 0 || (list.length >= 2 && racing.length === 1)) settle(r);
    else if (now > r.startsAt + 300000) settle(r);       // nobody should fly for 5 minutes
  }
}, 500);

/* ---------- websocket protocol ---------- */
const PATH_OK = /^[A-Za-z0-9_\-.~:@+]+(\/[A-Za-z0-9_\-.~:@+]+)*$/;
const ROOM_OK = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
/* rooms are named cursorrace-<table>; that suffix is the table the race runs on */
const tableOf = name => {
  const m = /^cursorrace-([a-z0-9]{1,8})$/.exec(name);
  return m ? m[1] : null;
};

function onMessage(peerId, raw) {
  const me = peers.get(peerId);
  if (!me) return;
  let m;
  try { m = JSON.parse(raw); } catch (e) { return; }
  const reply = (ok, extra) => {
    if (m.id) me.conn.json(Object.assign({ type: "ack", id: m.id, ok }, extra || {}));
  };
  const p = typeof m.path === "string" ? m.path : "";
  if (["get", "set", "update", "del", "acquire", "watch", "unwatch"].includes(m.type)) {
    if (!PATH_OK.test(p) || p.length > 300) return reply(false, { code: "invalid_argument" });
  }

  switch (m.type) {
    case "get":
      return reply(true, { data: readFor(me.uid, p), version: store.version(p) });

    case "set":
    case "update": {
      const err = writeFor(me.uid, p, m.data, m.type);
      return reply(!err, err ? { code: err } : {});
    }

    case "del":
      if (/^data\/users\/([^/]+)\//.test(p) && !p.startsWith("data/users/" + me.uid + "/")) {
        return reply(false, { code: "not_permitted" });
      }
      store.del(p);
      return reply(true);

    case "acquire":
      return reply(true, { result: store.acquire(p, String(m.holder || me.uid), Number(m.ttlMs) || 30000) });

    case "watch": {
      let set = watchers.get(p);
      if (!set) { set = new Set(); watchers.set(p, set); }
      set.add(peerId);
      me.conn.json({ type: "doc", path: p, data: readFor(me.uid, p), version: store.version(p) });
      return reply(true);
    }

    case "unwatch": {
      const set = watchers.get(p);
      if (set) set.delete(peerId);
      return reply(true);
    }

    case "join": {
      const name = String(m.room || "");
      if (!ROOM_OK.test(name)) return reply(false, { code: "invalid_argument" });
      if (me.rooms.size >= 4 && !me.rooms.has(name)) return reply(false, { code: "limit_reached" });
      const err = joinRoom(peerId, name);
      return reply(!err, err ? { code: err } : {});
    }

    case "leave":
      leaveRoom(peerId, String(m.room || ""));
      return reply(true);

    case "presence": {
      const patch = m.patch && typeof m.patch === "object" ? m.patch : {};
      const name = m.room ? String(m.room) : null;
      if (name && !me.rooms.has(name)) return reply(false, { code: "not_permitted" });
      const next = Object.assign({}, (name ? me.rooms.get(name) : me.presence) || {});
      for (const k of Object.keys(patch)) {
        if (patch[k] === null) delete next[k]; else next[k] = patch[k];
      }
      if (JSON.stringify(next).length > 4096) return reply(false, { code: "invalid_argument" });
      if (name) {
        me.rooms.set(name, next);
        ledger(me.uid, next, peerId, tableOf(name));
        broadcastRoom(name);
      } else {
        me.presence = next;
        broadcastPeers();
      }
      return reply(true);
    }

    case "emit": {
      const topic = String(m.topic || "");
      if (!/^[a-z][a-z0-9_.-]{0,47}$/.test(topic)) return reply(false, { code: "invalid_argument" });
      const name = m.room ? String(m.room) : null;
      if (name && !me.rooms.has(name)) return reply(false, { code: "not_permitted" });
      const out = JSON.stringify({ type: "event", room: name || undefined, topic, data: m.data, peer: peerId, uid: me.uid });
      const targets = name ? (rooms.get(name) || new Set()) : peers.keys();
      for (const peer of targets) {
        const q = peers.get(peer);
        if (q) q.conn.send(out);
      }
      return reply(true);
    }

    default:
      return reply(false, { code: "invalid_argument" });
  }
}

/* ---------- http ---------- */
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".wav": "audio/wav"
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  let uid = verify(cookieOf(req, "cr_session"));
  const setCookie = [];
  if (!uid) {
    uid = newUid();
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    setCookie.push("cr_session=" + sign(uid) + "; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax" + secure);
  }

  if (url.pathname === "/api/session") {
    const acct = store.get("users/" + uid);
    res.writeHead(200, { "content-type": MIME[".json"], "set-cookie": setCookie, "cache-control": "no-store" });
    return res.end(JSON.stringify({
      uid,
      coins: balance(uid),
      googleEnabled: google.configured(),
      account: acct ? { name: acct.name || "", email: acct.email || "", picture: acct.picture || "" } : null
    }));
  }

  /* ---------- Google sign-in ---------- */
  const redirectUri = () => {
    if (process.env.PUBLIC_URL) return String(process.env.PUBLIC_URL).replace(/\/+$/, "") + "/auth/google/callback";
    const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0] ||
      (process.env.NODE_ENV === "production" ? "https" : "http");
    return proto + "://" + (req.headers.host || "localhost") + "/auth/google/callback";
  };
  const cookieBits = (name, value, maxAge, path) =>
    name + "=" + value + "; Path=" + (path || "/") + "; Max-Age=" + maxAge +
    "; HttpOnly; SameSite=Lax" + (process.env.NODE_ENV === "production" ? "; Secure" : "");

  if (url.pathname === "/auth/google") {
    if (!google.configured()) {
      res.writeHead(503, { "content-type": MIME[".txt"] });
      return res.end("Google sign-in is not configured on this server.");
    }
    const state = crypto.randomBytes(16).toString("hex");
    const nonce = crypto.randomBytes(16).toString("hex");
    setCookie.push(cookieBits("cr_oauth", sign(state + "." + nonce), 600, "/auth"));
    res.writeHead(302, { location: google.authUrl(redirectUri(), state, nonce), "set-cookie": setCookie });
    return res.end();
  }

  if (url.pathname === "/auth/google/callback") {
    const fail = msg => {
      console.error("google sign-in:", msg);
      res.writeHead(302, {
        location: "/?signin=failed",
        "set-cookie": setCookie.concat([cookieBits("cr_oauth", "", 0, "/auth")])
      });
      res.end();
    };
    if (!google.configured()) return fail("not configured");
    const saved = verify(cookieOf(req, "cr_oauth"));
    const [state, nonce] = String(saved || "").split(".");
    if (!saved || !state || url.searchParams.get("state") !== state) return fail("state mismatch");
    const code = url.searchParams.get("code");
    if (!code) return fail(url.searchParams.get("error") || "no code");

    return google.exchange(code, redirectUri())
      .then(tok => {
        const claims = google.readIdToken(tok.id_token, nonce);
        const key = "identities/google:" + claims.sub;
        const linked = store.get(key);
        let target;
        if (linked && linked.uid) {
          target = linked.uid;                       // welcome back
        } else if (!store.get("users/" + uid)) {
          target = uid;                              // adopt this anonymous session, keeping its wallet
          store.set(key, { uid: target, created: Date.now() });
        } else {
          target = newUid();                         // already signed in as someone else
          store.set(key, { uid: target, created: Date.now() });
        }
        store.set("users/" + target, {
          provider: "google", sub: claims.sub,
          name: claims.name || claims.email || "pilot",
          email: claims.email || "",
          picture: claims.picture || "",
          updated: Date.now()
        });
        balance(target);
        console.log("signed in %s as %s", target.slice(0, 10), claims.email || claims.sub);
        res.writeHead(302, {
          location: "/",
          "set-cookie": [
            cookieBits("cr_session", sign(target), 31536000),
            cookieBits("cr_oauth", "", 0, "/auth")
          ]
        });
        res.end();
      })
      .catch(e => fail(e.message));
  }

  if (url.pathname === "/auth/logout") {
    res.writeHead(302, { location: "/", "set-cookie": [cookieBits("cr_session", sign(newUid()), 31536000)] });
    return res.end();
  }

  let file = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end("no"); }
  fs.readFile(full, (err, body) => {
    if (err) { res.writeHead(404, { "content-type": MIME[".txt"] }); return res.end("not found"); }
    const head = { "content-type": MIME[path.extname(full)] || "application/octet-stream" };
    if (setCookie.length) head["set-cookie"] = setCookie;
    head["cache-control"] = file === "index.html" ? "no-cache" : "public, max-age=300";
    res.writeHead(200, head);
    res.end(body);
  });
});

attach(server, "/ws", (conn, req) => {
  const uid = verify(cookieOf(req, "cr_session"));
  if (!uid) { conn.json({ type: "error", code: "no_session" }); conn.close(); return; }
  const peerId = crypto.randomBytes(8).toString("hex");
  peers.set(peerId, { conn, uid, presence: {}, rooms: new Map() });
  conn.json({ type: "ready", peer: peerId, uid, now: Date.now() });
  broadcastPeers();
  conn.on("message", raw => onMessage(peerId, raw));
  conn.on("close", () => {
    const p = peers.get(peerId);
    if (p) for (const name of [...p.rooms.keys()]) leaveRoom(peerId, name);
    peers.delete(peerId);
    for (const set of watchers.values()) set.delete(peerId);
    for (const r of rounds.values()) {
      for (const e of r.entrants.values()) if (e.peer === peerId && e.state === "racing") e.state = "out";
    }
    broadcastPeers();
  });
});

server.listen(PORT, () => {
  console.log("Cursor Race on http://localhost:" + PORT);
  console.log("store: " + DATA);
});
