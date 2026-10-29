"use strict";
/* Cursor Clash self-hosted server.

   Serves the game and stands in for the three claude.ai runtime services the
   page expects: a presence room, a document store and an identity. The wallet
   and the race clock are the server's, not the client's. */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { attach } = require("./ws");
const { Store, SplitStore } = require("./store");
const G = require("./game");
const google = require("./google");
const { Chat, Throttle, clean: cleanChat } = require("./chat");

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

/* Two regions on two subdomains are two different hosts, and a cookie without
   a Domain goes back to one of them only - so the same player would be handed
   a fresh id on the other and sharing the session secret would buy nothing.
   Set COOKIE_DOMAIN to the parent (".example.com") and both can read it.
   Worth setting even with one server: it is what lets a second region be added
   later without every player being handed a new id and losing their wallet. */
const COOKIE_SCOPE = process.env.COOKIE_DOMAIN ? "; Domain=" + process.env.COOKIE_DOMAIN : "";

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

/* One region, or several. With no DATABASE_URL this is the single JSON file it
   has always been. With one, races stay here and accounts live in Postgres, so
   a player keeps their coins and their cursors whichever server they land on.
   store.js decides which paths go where. */
const local = new Store(DATA);
const REGION = process.env.REGION || "";

/* Where else a player could be playing. REGIONS is a comma separated list of
   id|name|origin, and a server naming more than itself is telling the page
   there is a choice to make. Each origin answers /api/ping from anywhere, so
   the page can time all of them and pick rather than guess from an address. */
const REGIONS = String(process.env.REGIONS || "")
  .split(",").map(x => x.trim()).filter(Boolean)
  .map(x => { const [id, name, url] = x.split("|").map(y => (y || "").trim());
              return id && url ? { id, name: name || id, url: url.replace(/\/+$/, "") } : null; })
  .filter(Boolean);
let shared = null;

if (process.env.DATABASE_URL) {
  const { Pool } = require("pg");
  const { PgStore, pgConfig } = require("./pgstore");
  const pool = new Pool(Object.assign(
    pgConfig(process.env.DATABASE_URL),
    { max: Number(process.env.DATABASE_POOL || 6) }
  ));
  pool.on("error", e => console.error("postgres pool:", e.message));
  shared = new PgStore(pool, (...a) => console.error(...a));
}

const store = new SplitStore(local, shared);

/* ---------- the chat ----------
   One conversation across the regions, through the shared database where
   there is one (chat.js). Anyone may read it; talking takes a signed-in
   account, which is the cheapest guard there is against a bot. The owners
   named in CHAT_ADMINS (Google emails) can take a line down, which also
   keeps its author quiet for a day. */
const chat = new Chat({ pool: shared ? shared.pool : null, log: (...a) => console.error(...a) });
const chatThrottle = new Throttle(3, 2000);
const chatLast = new Map();                     // uid -> { text, at }: the same line twice is not said twice
const CHAT_ADMINS = new Set(String(process.env.CHAT_ADMINS || "")
  .split(",").map(x => x.trim().toLowerCase()).filter(Boolean));
const CHAT_BAN_MS = 24 * 3600000;
const chatWho = uid => crypto.createHmac("sha256", SECRET).update("chat:" + uid).digest("hex").slice(0, 12);
const chatAdmin = uid => {
  const acct = store.get("users/" + uid);
  return !!(acct && acct.email && CHAT_ADMINS.has(String(acct.email).toLowerCase()));
};
function chatMe(uid) {
  const ban = store.get("chatban/" + uid);
  return { talk: !!store.get("users/" + uid), admin: chatAdmin(uid), quiet: !!(ban && ban.until > Date.now()), who: chatWho(uid) };
}
/* what a player is called in the chat: the name and colour they race under */
function chatName(uid) {
  const prof = store.get("data/users/" + uid + "/profile") || {};
  const acct = store.get("users/" + uid) || {};
  const name = cleanChat(prof.name || String(acct.name || "").split(" ")[0] || "pilot").slice(0, 14) || "pilot";
  const color = /^#[0-9a-f]{6}$/i.test(String(prof.color || "")) ? String(prof.color) : "";
  return { name, color };
}
function chatSay(uid, raw) {
  const now = Date.now();
  if (!store.get("users/" + uid)) return "signin";
  const ban = store.get("chatban/" + uid);
  if (ban && ban.until > now) return "quiet";
  const text = cleanChat(raw);
  if (!text) return "empty";
  const last = chatLast.get(uid);
  if (last && last.text === text && now - last.at < 30000) return "again";
  if (!chatThrottle.take(uid, now)) return "slow";
  chatLast.set(uid, { text, at: now });
  if (chatLast.size > 5000) for (const [k, v] of chatLast) if (now - v.at > 60000) chatLast.delete(k);
  const { name, color } = chatName(uid);
  chat.say({ mid: "m" + now.toString(36) + crypto.randomBytes(4).toString("hex"), at: now,
             uid, who: chatWho(uid), name, color, text });
  return null;
}
/* a change goes out once, the same bytes to everyone listening */
chat.onChange(change => {
  const msg = JSON.stringify(Object.assign({ type: "chat" },
    change.add ? { add: chat.view(change.add) } : { gone: change.gone }));
  for (const p of peers.values()) if (p.chat) p.conn.send(msg);
});

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
  purse(uid);                                   // the row has to exist first
  const key = what === "gems" ? "gems" : "coins";
  // where there is a shared database it does the sum, so two regions cannot
  // lose a delta between reading a balance and writing it back
  const now = store.bump("wallets/" + uid, key, Math.round(delta));
  if (delta) {
    console.log("  purse %s %s%d %s -> %d (%s)",
      uid.slice(0, 10), delta > 0 ? "+" : "", delta, key, now, why);
  }
  return now;
}

/* What a player now owns that they did not before, and what it costs. */
function chargeForNewGear(uid, wanted, held) {
  const list = (o, k) => (o && Array.isArray(o[k]) ? o[k] : []);
  let coins = 0, gems = 0;
  const addedSkins = list(wanted, "skins").filter(id => !list(held, "skins").includes(id));
  const addedTails = list(wanted, "tails").filter(id => !list(held, "tails").includes(id));
  const addedGrounds = list(wanted, "grounds").filter(id => !list(held, "grounds").includes(id));
  for (const id of addedSkins) coins += G.SKIN_COST[id] || 0;
  for (const id of addedGrounds) coins += G.GROUND_COST[id] || 0;   // grounds are coins too
  for (const id of addedTails) gems += G.TAIL_COST[id] || 0;
  if (!coins && !gems) return true;
  const p = purse(uid);
  if (p.coins < coins || p.gems < gems) return false;
  if (coins) move(uid, -coins, "bought " + addedSkins.concat(addedGrounds).join(","), "coins");
  if (gems) move(uid, -gems, "bought " + addedTails.join(","), "gems");
  return true;
}

/* ---------- the room ---------- */
const soloRuns = new Map();   // uid -> { id, startedAt } for a run in progress

/* How many sockets one address may hold open, and how many the server will
   hold at once. Nothing else here bounds volume: a single host could open
   sockets until the memory ceiling killed the process, and systemd would
   restart it into the same flood.

   Behind the proxy every connection arrives from Cloudflare, so the address
   that matters is the one it forwards. That header is only believed when
   TRUST_PROXY says the proxy is genuinely in front - a header anyone can set
   is no limit at all, and trusting it on a naked origin would hand an
   attacker an unlimited supply of distinct "addresses". */
const CONN_PER_IP = Number(process.env.CONN_PER_IP || 24);
const CONN_TOTAL = Number(process.env.CONN_TOTAL || 1200);
const TRUST_PROXY = !!process.env.TRUST_PROXY;
const heldByIp = new Map();

function clientIp(req) {
  if (TRUST_PROXY) {
    const cf = req.headers["cf-connecting-ip"];
    if (cf) return String(cf).slice(0, 45);
    const fwd = req.headers["x-forwarded-for"];
    if (fwd) return String(fwd).split(",")[0].trim().slice(0, 45);
  }
  return (req.socket && req.socket.remoteAddress) || "?";
}
const peers = new Map();       // peerId -> { conn, uid, presence, rooms: Map(name -> presence) }
const rooms = new Map();       // room name -> Set(peerId)
const watchers = new Map();    // docPath -> Set(peerId)

function peerList() {
  const out = [];
  for (const [peer, p] of peers) out.push({ peer, uid: p.uid, presence: p.presence || {} });
  return out;
}

/* What the lobby screen actually needs.

   The roster used to go out whole: every peer's presence, to every peer, so
   the bytes went as the square of the people on the site - 21 KB a message
   at a hundred and fifty of them, and that message sent to all hundred and
   fifty. Nothing on that screen reads an individual: the lobby list wants
   counts, the made lobbies want their names, and the one peer that carries a
   lobby's name wants to know whether it is still the one. That is all this
   is, and it is the size of the lobby list rather than the size of the crowd.

   Players sitting in a lobby together still get each other in full - that is
   the table's own room, and it stops at ten. */
/* A lobby somebody made is kept on the list for a while after the last pilot
   steps out of it.

   It used to exist only while someone was sitting in it, which costs nothing
   to run but makes the one thing you want to do with a public lobby
   impossible: you cannot go and look at it on the list, because looking means
   leaving, and leaving means it is gone. So the server remembers the open
   ones. In memory, capped, and swept - this is an advert, not a record, and
   it is gone when the server restarts, which is the right lifetime for it. */
const advertised = new Map();            // id -> { name, priv, until }
/* The hoardings along the channel are sold at the desk (BOARDS_URL). What is
   up is fetched from there once a minute, each picture fetched once and kept,
   and both handed to the page from this origin - so a picture can be drawn to
   the canvas without tainting it, and players never speak to the desk at all.
   The sightings the page reports are added up and sent on once a minute. */
const BOARDS_URL = String(process.env.BOARDS_URL || "").replace(/\/+$/, "");
const BOARDS_KEY = process.env.BOARDS_KEY || "";
let boards = [];                        // [{ id, name, link, animated }]
const boardPics = new Map();            // id -> { buf, type }
const sightings = new Map();            // id -> count since the last report
async function pullBoards() {
  try {
    const r = await fetch(BOARDS_URL + "/v1/active", { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error("http " + r.status);
    const list = await r.json();
    if (!Array.isArray(list)) throw new Error("not a list");
    const next = [];
    for (const a of list.slice(0, 40)) {
      if (!a || !/^[a-zA-Z0-9]{5,10}$/.test(String(a.id)) || typeof a.image !== "string") continue;
      if (!boardPics.has(a.id)) {
        try {
          const pr = await fetch(a.image, { signal: AbortSignal.timeout(15000) });
          if (!pr.ok) continue;
          const buf = Buffer.from(await pr.arrayBuffer());
          if (buf.length > 6 * 1024 * 1024) continue;
          boardPics.set(a.id, { buf, type: pr.headers.get("content-type") || "image/webp" });
        } catch (e) { continue; }
      }
      next.push({ id: a.id, name: String(a.name || "").slice(0, 40),
                  link: /^https?:\/\//.test(String(a.link)) ? String(a.link).slice(0, 300) : "", animated: !!a.animated,
                  weight: Math.min(10, Math.max(0.05, Number(a.weight) || 1)) });
    }
    boards = next;
    for (const id of [...boardPics.keys()]) if (!next.some(a => a.id === id)) boardPics.delete(id);
  } catch (e) { console.warn("boards: " + e.message); }
}
async function reportSightings() {
  if (!BOARDS_KEY || !sightings.size) return;
  const counts = Object.fromEntries(sightings); sightings.clear();
  try {
    const r = await fetch(BOARDS_URL + "/v1/seen", { method: "POST", signal: AbortSignal.timeout(8000),
      headers: { "content-type": "application/json", "x-billboard-key": BOARDS_KEY }, body: JSON.stringify({ counts }) });
    if (!r.ok) throw new Error("http " + r.status);
  } catch (e) {        // kept for the next try
    for (const [id, n] of Object.entries(counts)) sightings.set(id, (sightings.get(id) || 0) + n);
  }
}
if (BOARDS_URL) {
  pullBoards(); setInterval(pullBoards, 60000); setInterval(reportSightings, 60000);
  console.log("hoardings from " + BOARDS_URL + (BOARDS_KEY ? "" : " (no BOARDS_KEY: sightings are not reported)"));
}

const ADVERT_FOR = 20 * 60 * 1000;
const ADVERT_MAX = 80;

function remember(id, name, priv, own) {
  const row = advertised.get(id) || {};
  row.name = name; row.priv = priv; row.own = own || row.own || "";
  row.until = Date.now() + ADVERT_FOR;
  advertised.set(id, row);
  if (advertised.size > ADVERT_MAX) {     // oldest advert makes way
    let oldest = null, at = Infinity;
    for (const [k, v] of advertised) if (v.until < at) { at = v.until; oldest = k; }
    if (oldest) advertised.delete(oldest);
  }
}

function lobbyDigest() {
  const seats = new Map();
  const people = new Set();
  for (const [peer, p] of peers) {
    const pr = p.presence || {};
    people.add(p.uid || peer);
    const at = pr.table;
    if (typeof at !== "string" || !at) continue;
    let slot = seats.get(at);
    if (!slot) { slot = { who: new Set(), busy: false, first: peer }; seats.set(at, slot); }
    slot.who.add(p.uid || peer);          // a second tab is not a second pilot
    if (pr.busy) slot.busy = true;
    if (peer < slot.first) slot.first = peer;
    if (pr.lname) {
      slot.name = String(pr.lname).slice(0, 24);
      slot.priv = pr.priv ? 1 : 0;
      slot.own = typeof pr.lown === "string" ? pr.lown.slice(0, 40) : "";
    }
  }
  const now = Date.now();
  const lobbies = {};
  for (const [id, slot] of seats) {
    const row = { n: slot.who.size, first: slot.first };
    if (slot.busy) row.busy = 1;
    if (slot.name) {
      row.name = slot.name; row.priv = slot.priv; row.own = slot.own;
      remember(id, slot.name, slot.priv, slot.own);          // keep advertising it
    } else {
      const kept = advertised.get(id);             // nobody is carrying it this instant
      if (kept && kept.until > now) { row.name = kept.name; row.priv = kept.priv; row.own = kept.own; }
    }
    lobbies[id] = row;
  }
  // and the ones standing open with nobody in them yet
  for (const [id, kept] of advertised) {
    if (lobbies[id]) continue;
    if (kept.until <= now) { advertised.delete(id); continue; }
    if (kept.priv) continue;                       // a private one is not advertised
    lobbies[id] = { n: 0, first: "", name: kept.name, priv: 0, own: kept.own, open: 1 };
  }
  return { people: people.size, lobbies };
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
    const msg = JSON.stringify({ type: "peers", sum: lobbyDigest() });
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
  if (p.startsWith("wallets/") || p.startsWith("identities/") || p.startsWith("chatban/")) return null;
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

  /* A single-player run earns coins now, and has no other pilots to keep it
     honest. So the server notes when one opens and will not credit more than
     that many seconds could have earned - the same arithmetic a race settles
     with. One claim per run, and the run is forgotten once claimed. */
  const solo = /^solo\/(.+)$/.exec(p);
  if (solo) {
    if (solo[1] !== uid) return "not_permitted";
    if (data && typeof data.open === "string") {
      soloRuns.set(uid, { id: data.open.slice(0, 32), startedAt: Date.now() });
      return null;
    }
    const run = soloRuns.get(uid);
    if (!run || !data || data.run !== run.id) return "not_permitted";
    soloRuns.delete(uid);
    const span = G.maxDistAt(run.startedAt, Date.now());
    const coins = Math.min(Math.max(0, Math.round(Number(data.coins) || 0)),
                           Math.max(0, Math.floor((span + G.H) / 520) + 1));
    const gems = Math.min(Math.max(0, Math.round(Number(data.gems) || 0)),
                          Math.ceil(span / 700) + 2);
    if (coins) move(uid, coins, "solo run");
    if (gems) move(uid, gems, "solo gems", "gems");
    return null;
  }

  if (p === "board/top" || p === "board/solo") {
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

  if (p.startsWith("wallets/") || p.startsWith("results/") || p.startsWith("chatban/") ||
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
    entrants: new Map()    // uid -> { peer, name, dist, state, paid }
  };
  rounds.set(table, r);
  store.set("live/" + table, { rid, startsAt: r.startsAt, serverNow: now, host, gate: G.JOIN_WINDOW });
  console.log("%s: race %s opens, gate shuts in %ds", table, rid, G.JOIN_WINDOW / 1000);
}

/* Presence is the only thing the clients report, so the ledger reads it:
   a seat is charged the first time a player claims one. */
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
    /* Gates cleared and gems taken, as reported, and only ever growing -
       except after a wipe: a pilot who stepped in something reports the run's
       take starting over, with a count of wipes beside it so this can tell a
       wipe from a stale report. */
    const pw = Number(pres.pw) || 0;
    if (pw > (e.pw || 0)) { e.pw = pw; e.rc = Number(pres.rc) || 0; e.rg = Number(pres.rg) || 0; }
    else {
      e.rc = Math.max(e.rc || 0, Number(pres.rc) || 0);
      e.rg = Math.max(e.rg || 0, Number(pres.rg) || 0);
    }
    return;
  }
}

function settle(r) {
  r.settled = true;
  const list = [...r.entrants.entries()].map(([uid, e]) => Object.assign({ uid }, e));
  const racing = list.filter(e => e.state === "racing");
  /* Whoever was last in the channel won, even though they have since clipped
     a wall themselves - they outlived the field, and the extra distance they
     flew after that was for the board, not for the pot. */
  const winner = (r.lastOne && list.find(e => e.uid === r.lastOne)) ||
    (racing.length === 1 ? racing[0] : list.slice().sort((a, b) => b.dist - a.dist)[0]);
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

  store.set("results/" + r.rid, {
    rid: r.rid, table: r.table, at: Date.now(), pot,
    winner: winner ? { uid: winner.uid, name: winner.name, dist: Math.round(winner.dist) } : null,
    field: list.map(e => ({ name: e.name, dist: Math.round(e.dist) }))
  });
  console.log("%s: race %s won by %s, pot %d%s", r.table, r.rid,
    winner ? winner.name : "nobody", pot,
    r.lastOne ? " (last one in, flew to " + Math.round((winner ? winner.dist : 0) / 10) + " m)" : "");

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

/* A race needs someone to race. Called off, the seats go back. */
function callOff(r, now) {
  for (const [uid, e] of r.entrants) if (e.paid) move(uid, G.ENTRY_FEE, "refund " + r.rid);
  r.settled = true;
  rounds.delete(r.table);
  store.set("live/" + r.table, { rid: "", cancelled: true, serverNow: now, host: "" });
  console.log("%s: race %s called off, nobody else took a seat", r.table, r.rid);
}

setInterval(() => {
  const now = Date.now();
  for (const r of [...rounds.values()]) {
    if (r.settled) continue;

    /* The lights come on four seconds before the gate shuts, and a pilot
       sitting alone under them is not going to be joined in the time left;
       the page has already stopped asking. So it is called off there, not
       four seconds later with the lights having run their course. */
    if (!r.litCheck && now >= r.startsAt - 4000) {
      r.litCheck = true;
      if (r.entrants.size < 2) { callOff(r, now); continue; }
    }
    if (now < r.startsAt) continue;

    /* Asked once more once the gate has shut, since a seat can still be
       taken in those last seconds and, in principle, given up. Nothing else
       about the round is decided until this has been asked, or a lone pilot
       who clipped a wall on the first frame would be settled as the winner
       of their own pot. */
    if (!r.checked) {
      if (now < r.startsAt + 700) continue;      // seats are still accepted to +500
      r.checked = true;
      if (r.entrants.size < 2) { callOff(r, now); continue; }
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

    /* The last pilot in the channel has won it, and the pot is theirs whatever
       happens next - there is nobody left to take it from them. But a race is
       a distance as well as a result, and there is a board with their name on
       it, so the channel stays open and they fly on until they clip something. */
    if (list.length >= 2 && racing.length === 1 && !r.lastOne) {
      /* the loop walks values, which carry no uid of their own - the uid is
         the key, so it has to be looked up by identity */
      for (const [uid, e] of r.entrants) if (e === racing[0]) { r.lastOne = uid; break; }
      console.log("%s: race %s is decided, %s flies on", r.table, r.rid, racing[0].name);
    }
    if (racing.length === 0) settle(r);
    else if (now > r.startsAt + 300000) settle(r);       // nobody should fly for 5 minutes
  }
}, 500);

/* Lobbies people make themselves leave a live/ document behind, and nothing
   on the way out is guaranteed to run - a closed tab does not get to clean up
   after itself. Left alone they only accumulate, and every write serialises
   the whole store: six documents is nothing, twenty thousand is an eleven
   millisecond freeze on the event loop for everyone racing. So anything that
   is not one of the house lobbies, has no race in it and has been quiet for
   an hour is thrown away. The six are left where they are. */
const HOUSE = new Set(["t1", "t2", "t3", "t4", "t5", "t6"]);
const STRAY_AFTER = Number(process.env.LOBBY_STRAY_MS || 60 * 60 * 1000);
const SWEEP_EVERY = Number(process.env.LOBBY_SWEEP_MS || 10 * 60 * 1000);

setInterval(() => {
  const now = Date.now();
  let gone = 0;
  for (const path of store.list("live/")) {
    const id = path.slice(5);
    if (HOUSE.has(id) || rooms.has("cursorrace-" + id) || rounds.has(id)) continue;
    const doc = store.get(path);
    if (!doc || doc.rid) continue;                   // a race is still on it
    const quietSince = Number(doc.serverNow) || 0;
    if (now - quietSince < STRAY_AFTER) continue;
    store.del(path);
    gone++;
  }
  if (gone) console.log("swept %d empty %s", gone, gone === 1 ? "lobby" : "lobbies");
}, SWEEP_EVERY);

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

    /* The chat. `sub` is the page saying whether it is showing the chat -
       on the home screen it is, at the gate and in a race it is not, and
       nothing is sent to it then. Each time it starts listening it gets the
       history whole, which is how it catches up after a race. */
    case "chat": {
      if (m.op === "sub") {
        me.chat = !!m.on;
        if (me.chat) me.conn.json({ type: "chat", all: chat.view(), me: chatMe(me.uid) });
        return reply(true);
      }
      if (m.op === "say") {
        const err = chatSay(me.uid, m.text);
        return reply(!err, err ? { code: err } : {});
      }
      if (m.op === "del") {
        if (!chatAdmin(me.uid)) return reply(false, { code: "not_permitted" });
        const line = chat.remove(String(m.mid || ""));
        if (line && line.uid && !chatAdmin(line.uid)) {
          store.set("chatban/" + line.uid, { until: Date.now() + CHAT_BAN_MS, by: me.uid, at: Date.now() });
          console.log("chat: took down a line by %s and quietened them for a day", line.uid.slice(0, 10));
        }
        return reply(true);
      }
      return reply(false, { code: "invalid_argument" });
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
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".wav": "audio/wav",
  ".xml": "application/xml; charset=utf-8", ".webp": "image/webp", ".webmanifest": "application/manifest+json"
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  let uid = verify(cookieOf(req, "cr_session"));
  const setCookie = [];
  if (!uid) {
    uid = newUid();
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    setCookie.push("cr_session=" + sign(uid) + "; Path=/; Max-Age=31536000" + COOKIE_SCOPE +
      "; HttpOnly; SameSite=Lax" + secure);
  }

  /* Timed from the page, from any origin, so a player can find out which
     server is actually nearest instead of being guessed at from their address. */
  if (url.pathname === "/api/ping") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "cache-control": "no-store, no-cache, must-revalidate",
      "timing-allow-origin": "*"
    });
    res.end();
    return;
  }

  /* The tunables the page keeps its own defaults for. It asks once at boot, so
     changing ENTRY_FEE or TABLE_CAP in the env file is enough - without this a
     server quietly allowing 13 to a table still shows 10 on every card, and
     refuses the eleventh pilot from the page before the server ever sees them. */
  if (url.pathname === "/api/boards") {
    res.writeHead(200, { "content-type": MIME[".json"], "cache-control": "public, max-age=60" });
    res.end(JSON.stringify(boards.map(a => ({ id: a.id, name: a.name, link: a.link, animated: a.animated, weight: a.weight, image: "/api/boards/img/" + a.id + ".webp" }))));
    return;
  }
  const boardPic = /^\/api\/boards\/img\/([a-zA-Z0-9]+)\.webp$/.exec(url.pathname);
  if (boardPic) {
    const pic = boardPics.get(boardPic[1]);
    if (!pic) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": pic.type, "content-length": pic.buf.length, "cache-control": "public, max-age=3600" });
    res.end(pic.buf);
    return;
  }
  if (url.pathname === "/api/boards/seen" && req.method === "POST") {
    let body = "";
    req.on("data", d => { body += d; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      try {
        const ids = JSON.parse(body).ids;
        for (const id of (Array.isArray(ids) ? ids.slice(0, 50) : []))
          if (boards.some(a => a.id === id)) sightings.set(id, (sightings.get(id) || 0) + 1);
      } catch (e) {}
      res.writeHead(204); res.end();
    });
    return;
  }

  if (url.pathname === "/api/rules") {
    res.writeHead(200, {
      "content-type": MIME[".json"],
      "access-control-allow-origin": "*",
      "cache-control": "no-store"
    });
    res.end(JSON.stringify({
      tableCap: G.TABLE_CAP, entryFee: G.ENTRY_FEE, joinWindow: G.JOIN_WINDOW,
      startCoins: G.START_COINS
    }));
    return;
  }

  if (url.pathname === "/api/regions") {
    res.writeHead(200, {
      "content-type": MIME[".json"],
      "access-control-allow-origin": "*",
      "cache-control": "no-store"
    });
    res.end(JSON.stringify({ here: REGION, regions: REGIONS }));
    return;
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
    name + "=" + value + "; Path=" + (path || "/") + "; Max-Age=" + maxAge + COOKIE_SCOPE +
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
  if (file === "favicon.ico") file = "favicon.png";       // asked for by name by browsers that never read the page; a PNG is fine by them
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end("no"); }
  fs.readFile(full, (err, body) => {
    if (err) { res.writeHead(404, { "content-type": MIME[".txt"] }); return res.end("not found"); }
    const head = { "content-type": MIME[path.extname(full)] || "application/octet-stream" };
    if (setCookie.length) head["set-cookie"] = setCookie;
    /* Everything under media/ is named by a hash of what is in it, so it can
       never go stale: a changed file is a different name. The page itself has
       to be revalidated, since its name never changes. */
    head["cache-control"] = file === "index.html" ? "no-cache"
      : /^media\//.test(file) ? "public, max-age=31536000, immutable"
      : "public, max-age=300";
    res.writeHead(200, head);
    res.end(body);
  });
});

attach(server, "/ws", (conn, req) => {
  const uid = verify(cookieOf(req, "cr_session"));
  if (!uid) { conn.json({ type: "error", code: "no_session" }); conn.close(); return; }

  const ip = clientIp(req);
  const held = heldByIp.get(ip) || 0;
  if (peers.size >= CONN_TOTAL || held >= CONN_PER_IP) {
    conn.json({ type: "error", code: "busy" });
    conn.close();
    return;
  }
  heldByIp.set(ip, held + 1);

  const peerId = crypto.randomBytes(8).toString("hex");
  peers.set(peerId, { conn, uid, presence: {}, rooms: new Map(), chat: false });
  conn.json({ type: "ready", peer: peerId, uid, now: Date.now() });
  broadcastPeers();
  conn.on("message", raw => onMessage(peerId, raw));
  conn.on("close", () => {
    const n = (heldByIp.get(ip) || 1) - 1;
    if (n > 0) heldByIp.set(ip, n); else heldByIp.delete(ip);
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

(async () => {
  if (shared) {
    await shared.start();
    console.log("shared store: postgres" + (REGION ? " (region " + REGION + ")" : ""));
  }
  await chat.start();
  server.listen(PORT, () => {
    console.log("Cursor Clash on http://localhost:" + PORT);
    console.log("store: " + DATA + (shared ? "  (races only; accounts are shared)" : ""));
  });
})().catch(e => {
  console.error("could not start:", e.message);
  process.exit(1);
});
