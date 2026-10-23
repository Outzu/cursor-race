/* claude-shim.js — makes the Artifact runtime surface available off-platform.

   The game only ever reaches the outside world through `claude.use(name)`.
   This file provides the same three namespaces over one WebSocket to your own
   server, so the identical game file runs here and on claude.ai with no edits.

   Implemented: use("room")  -> connected, onConnection, emit, on, presence, peers, onPeers
                use("db")    -> doc(path) with get/set/update/delete/acquire/onSnapshot/collection
                use("user")  -> id, me, isOwner, canEdit, can, profiles
   Anything else resolves null, exactly as an unavailable capability does. */

(function () {
  "use strict";

  var WS_PATH = "/ws";
  var RETRY_MIN = 500, RETRY_MAX = 10000;

  var ws = null, connected = false, ready = false, retry = RETRY_MIN;
  var uid = null, myPeer = null;
  var seq = 0, pending = new Map();
  var myPresence = {}, peers = Object.freeze([]);
  var connFns = [], peerFns = [], topicFns = new Map(), docFns = new Map();
  var readyWaiters = [];
  var rooms = new Map();   // name -> named room state

  function fire(list, arg) {
    for (var i = 0; i < list.length; i++) {
      try { list[i](arg); } catch (e) { console.error("[shim]", e); }
    }
  }
  function remover(list, fn) {
    return function () { var i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
  }

  function connect() {
    var proto = location.protocol === "https:" ? "wss://" : "ws://";
    try { ws = new WebSocket(proto + location.host + WS_PATH); } catch (e) { return schedule(); }

    ws.onopen = function () { retry = RETRY_MIN; };

    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }

      if (m.type === "ready") {
        uid = m.uid; myPeer = m.peer; ready = true;
        if (!connected) { connected = true; fire(connFns, true); }
        // a reconnect starts a fresh peer, so re-assert what this tab was doing
        if (Object.keys(myPresence).length) send({ type: "presence", patch: myPresence });
        docFns.forEach(function (_, path) { send({ type: "watch", path: path }); });
        rooms.forEach(function (r, name) {
          send({ type: "join", room: name });
          if (Object.keys(r.presence).length) send({ type: "presence", room: name, patch: r.presence });
        });
        fire(readyWaiters, true); readyWaiters = [];
        return;
      }

      if (m.type === "ack") {
        var p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.ok) p.resolve(m); else p.reject({ code: m.code || "unavailable", message: m.code || "refused" });
        return;
      }

      if (m.type === "peers") {
        if (m.room) {
          var r = rooms.get(m.room);
          if (r) r.apply(m.peers || []);
          return;
        }
        var before = peers;
        peers = Object.freeze((m.peers || []).map(function (p) {
          return Object.freeze({
            peer: p.peer,
            by: p.uid || null,
            isMe: p.uid === uid,
            sameTab: p.peer === myPeer,
            kind: "viewer",
            guest: false,
            presence: Object.freeze(p.presence || {}),
            updatedAt: Date.now()
          });
        }));
        var had = {}, i;
        for (i = 0; i < before.length; i++) had[before[i].peer] = before[i];
        var now = {}, joined = [], updated = [], left = [];
        for (i = 0; i < peers.length; i++) {
          now[peers[i].peer] = peers[i];
          if (had[peers[i].peer]) updated.push(peers[i]); else joined.push(peers[i]);
        }
        for (i = 0; i < before.length; i++) if (!now[before[i].peer]) left.push(before[i]);
        fire(peerFns, { peers: peers, joined: joined, left: left, updated: updated });
        return;
      }

      if (m.type === "doc") {
        var list = docFns.get(m.path);
        if (!list) return;
        fire(list, snapshot(m.path, m.data, m.version));
        return;
      }

      if (m.type === "event" && m.room) {
        var er = rooms.get(m.room);
        if (er) er.event(m);
        return;
      }

      if (m.type === "event") {
        var fns = topicFns.get(m.topic);
        if (!fns) return;
        fire(fns, {
          topic: m.topic, data: m.data, peer: m.peer, by: m.uid || null,
          isMe: m.uid === uid, sameTab: m.peer === myPeer, kind: "viewer", guest: false
        });
        return;
      }
    };

    ws.onclose = function () {
      ready = false;
      if (connected) { connected = false; fire(connFns, false); }
      pending.forEach(function (p) { p.reject({ code: "unavailable", message: "disconnected" }); });
      pending.clear();
      schedule();
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  function schedule() {
    setTimeout(connect, retry);
    retry = Math.min(RETRY_MAX, Math.round(retry * 1.8));
  }

  function send(msg) {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(msg)); return true; }
    return false;
  }

  function call(msg) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      msg.id = id;
      if (!send(msg)) return reject({ code: "unavailable", message: "offline" });
      pending.set(id, { resolve: resolve, reject: reject });
      setTimeout(function () {
        if (pending.delete(id)) reject({ code: "unavailable", message: "timeout" });
      }, 12000);
    });
  }

  /* ---------- db ---------- */
  function snapshot(path, data, version) {
    var body = data && typeof data === "object" ? Object.freeze(data) : null;
    return Object.freeze({
      id: path.split("/").pop(),
      exists: !!body,
      data: function () { return body || undefined; },
      version: version || 0,
      metadata: Object.freeze({ fromCache: false, hasPendingWrites: false })
    });
  }
  function checkPath(path, even) {
    var parts = String(path).split("/");
    if (!path || parts.some(function (s) { return !s; })) throw new TypeError("bad path: " + path);
    if (even && parts.length % 2 !== 0) throw new TypeError("document paths need an even number of segments: " + path);
    if (!even && parts.length % 2 !== 1) throw new TypeError("collection paths need an odd number of segments: " + path);
  }

  function doc(path) {
    checkPath(path, true);
    return Object.freeze({
      id: path.split("/").pop(),
      path: path,
      get: function () {
        return call({ type: "get", path: path }).then(function (r) { return snapshot(path, r.data, r.version); });
      },
      set: function (data) { return call({ type: "set", path: path, data: data }).then(function () {}); },
      update: function (data) { return call({ type: "update", path: path, data: data }).then(function () {}); },
      delete: function () { return call({ type: "del", path: path }).then(function () {}); },
      acquire: function (o) {
        o = o || {};
        return call({ type: "acquire", path: path, holder: o.holder, ttlMs: o.ttlMs })
          .then(function (r) { return r.result || { acquired: false }; });
      },
      onSnapshot: function (next, onErr) {
        if (typeof next !== "function") throw new TypeError("onSnapshot needs a function");
        var list = docFns.get(path);
        if (!list) { list = []; docFns.set(path, list); }
        list.push(next);
        if (!send({ type: "watch", path: path })) {
          readyWaiters.push(function () { send({ type: "watch", path: path }); });
        }
        return function () {
          var l = docFns.get(path) || [];
          var i = l.indexOf(next);
          if (i >= 0) l.splice(i, 1);
          if (!l.length) { docFns.delete(path); send({ type: "unwatch", path: path }); }
        };
      },
      collection: function (p) { return collection(path + "/" + p); }
    });
  }

  function collection(path) {
    checkPath(path, false);
    return Object.freeze({
      path: path,
      doc: function (id) { return doc(path + "/" + (id || String(Date.now()) + Math.random().toString(36).slice(2, 8))); }
    });
  }

  /* ---------- room ---------- */
  var room = Object.freeze({
    connected: function () { return connected; },
    onConnection: function (fn, onErr) {
      connFns.push(fn);
      setTimeout(function () { fn(connected); }, 0);
      return remover(connFns, fn);
    },
    emit: function (topic, data) { return call({ type: "emit", topic: topic, data: data }).then(function () {}); },
    on: function (topic, fn, onErr) {
      var list = topicFns.get(topic);
      if (!list) { list = []; topicFns.set(topic, list); }
      list.push(fn);
      return remover(list, fn);
    },
    presence: function (patch) {
      for (var k in patch) {
        if (patch[k] === null) delete myPresence[k]; else myPresence[k] = patch[k];
      }
      return call({ type: "presence", patch: patch }).then(function () {});
    },
    peers: function () { return peers; },
    onPeers: function (fn, onErr) {
      peerFns.push(fn);
      setTimeout(function () {
        if (peers.length) fn({ peers: peers, joined: peers, left: [], updated: [] });
      }, 0);
      return remover(peerFns, fn);
    },
    join: function (name) {
      if (!/^[a-z0-9][a-z0-9_.-]{0,47}$/.test(String(name))) {
        return Promise.reject({ code: "invalid_argument", message: "bad room name" });
      }
      var existing = rooms.get(name);
      if (existing) return Promise.resolve(existing.api);
      var state = makeRoom(name);
      rooms.set(name, state);
      return call({ type: "join", room: name }).then(function () {
        return state.api;
      }, function (err) {
        rooms.delete(name);
        throw err;
      });
    },
    canSendToClaudeSession: function () { return Promise.resolve("off"); },
    sendToClaudeSession: function () { return Promise.reject({ code: "claude_unavailable", message: "not on claude.ai" }); }
  });

  /* one named room: same calls as the lobby, scoped to whoever joined this name */
  function makeRoom(name) {
    var st = {
      name: name,
      presence: {},
      peers: Object.freeze([]),
      peerFns: [],
      topicFns: new Map(),
      left: false
    };

    st.apply = function (list) {
      var before = st.peers;
      st.peers = Object.freeze(list.map(function (p) {
        return Object.freeze({
          peer: p.peer, by: p.uid || null,
          isMe: p.uid === uid, sameTab: p.peer === myPeer,
          kind: "viewer", guest: false,
          presence: Object.freeze(p.presence || {}), updatedAt: Date.now()
        });
      }));
      var had = {}, i, now = {}, joined = [], updated = [], left = [];
      for (i = 0; i < before.length; i++) had[before[i].peer] = true;
      for (i = 0; i < st.peers.length; i++) {
        now[st.peers[i].peer] = true;
        (had[st.peers[i].peer] ? updated : joined).push(st.peers[i]);
      }
      for (i = 0; i < before.length; i++) if (!now[before[i].peer]) left.push(before[i]);
      fire(st.peerFns, { peers: st.peers, joined: joined, left: left, updated: updated });
    };

    st.event = function (m) {
      var fns = st.topicFns.get(m.topic);
      if (!fns) return;
      fire(fns, {
        topic: m.topic, data: m.data, peer: m.peer, by: m.uid || null,
        isMe: m.uid === uid, sameTab: m.peer === myPeer, kind: "viewer", guest: false
      });
    };

    st.api = Object.freeze({
      name: name,
      connected: function () { return connected && !st.left; },
      onConnection: function (fn) { connFns.push(fn); setTimeout(function () { fn(connected); }, 0); return remover(connFns, fn); },
      emit: function (topic, data) { return call({ type: "emit", room: name, topic: topic, data: data }).then(function () {}); },
      on: function (topic, fn) {
        var list = st.topicFns.get(topic);
        if (!list) { list = []; st.topicFns.set(topic, list); }
        list.push(fn);
        return remover(list, fn);
      },
      presence: function (patch) {
        for (var k in patch) {
          if (patch[k] === null) delete st.presence[k]; else st.presence[k] = patch[k];
        }
        return call({ type: "presence", room: name, patch: patch }).then(function () {});
      },
      peers: function () { return st.peers; },
      onPeers: function (fn) {
        st.peerFns.push(fn);
        setTimeout(function () { if (st.peers.length) fn({ peers: st.peers, joined: st.peers, left: [], updated: [] }); }, 0);
        return remover(st.peerFns, fn);
      },
      leave: function () {
        if (st.left) return Promise.resolve();
        st.left = true;
        rooms.delete(name);
        st.peerFns.length = 0;
        return call({ type: "leave", room: name }).then(function () {}, function () {});
      }
    });

    return st;
  }

  var user = Object.freeze({
    id: function () { return Promise.resolve(uid); },
    me: function () { return Promise.resolve({ id: uid, guest: false }); },
    isOwner: function () { return false; },
    canEdit: function () { return true; },
    can: function () { return true; },
    profiles: function () { return Promise.resolve({}); }
  });

  var db = Object.freeze({ doc: doc, collection: collection });

  /* ---------- the one entry point the game uses ---------- */
  var booted = fetch("/api/session", { credentials: "same-origin" })
    .then(function (r) { return r.json(); })
    .catch(function () { return null; })
    .then(function () {
      connect();
      return new Promise(function (resolve) {
        if (ready) return resolve(true);
        readyWaiters.push(resolve);
        setTimeout(function () { resolve(ready); }, 8000);
      });
    });

  window.claude = {
    use: function (name) {
      if (name !== "room" && name !== "db" && name !== "user") return Promise.resolve(null);
      return booted.then(function (ok) {
        if (!ok && !ready) return null;
        return name === "room" ? room : name === "db" ? db : user;
      });
    }
  };
})();
