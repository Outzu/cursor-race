"use strict";
/* A minimal RFC 6455 WebSocket server on top of Node's http upgrade event.
   Text frames only, 1 MiB cap, no extensions — which is all this game needs,
   and it keeps the project dependency-free. */

const crypto = require("crypto");
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const accept = key => crypto.createHash("sha1").update(key + GUID).digest("base64");

class Conn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.fragOp = 0;
    this.open = true;
    this.handlers = {};
    socket.on("data", d => this.feed(d));
    socket.on("error", () => this.destroy());
    socket.on("close", () => this.destroy());
  }

  on(ev, fn) { (this.handlers[ev] || (this.handlers[ev] = [])).push(fn); return this; }
  fire(ev, a) {
    for (const fn of this.handlers[ev] || []) {
      try { fn(a); } catch (e) { console.error("ws handler:", e.message); }
    }
  }

  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const f = this.readFrame();
      if (!f) break;
      this.handle(f);
    }
  }

  readFrame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const op = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off); off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      if (b.readUInt32BE(off) !== 0) { this.destroy(); return null; }
      len = b.readUInt32BE(off + 4); off += 8;
    }
    if (len > (1 << 20)) { this.destroy(); return null; }
    let mask = null;
    if (masked) {
      if (b.length < off + 4) return null;
      mask = b.subarray(off, off + 4); off += 4;
    }
    if (b.length < off + len) return null;
    const data = Buffer.from(b.subarray(off, off + len));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    this.buf = b.subarray(off + len);
    return { fin, op, data };
  }

  handle(f) {
    if (f.op === 0x8) { this.close(); return; }
    if (f.op === 0x9) { this.send(f.data, 0xa); return; }
    if (f.op === 0xa) return;
    if (f.op === 0x0) {
      if (!this.frag) return;
      this.frag = Buffer.concat([this.frag, f.data]);
    } else {
      this.frag = f.data;
      this.fragOp = f.op;
    }
    if (!f.fin) return;
    const payload = this.frag, op = this.fragOp;
    this.frag = null;
    if (op === 0x1) this.fire("message", payload.toString("utf8"));
  }

  send(payload, op) {
    if (!this.open) return;
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
    const len = data.length;
    let head;
    if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
    else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
    head[0] = 0x80 | (op || 0x1);
    try { this.socket.write(Buffer.concat([head, data])); } catch (e) { this.destroy(); }
  }

  json(obj) { this.send(JSON.stringify(obj)); }

  close() {
    if (!this.open) return;
    try { this.send(Buffer.alloc(0), 0x8); this.socket.end(); } catch (e) {}
    this.destroy();
  }

  destroy() {
    if (!this.open) return;
    this.open = false;
    try { this.socket.destroy(); } catch (e) {}
    this.fire("close");
  }
}

function attach(server, path, onConn) {
  server.on("upgrade", (req, socket, head) => {
    const url = (req.url || "").split("?")[0];
    const key = req.headers["sec-websocket-key"];
    if (url !== path || !key || String(req.headers.upgrade || "").toLowerCase() !== "websocket") {
      socket.destroy();
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " + accept(key) + "\r\n\r\n"
    );
    socket.setNoDelay(true);
    const conn = new Conn(socket);
    if (head && head.length) conn.feed(head);
    onConn(conn, req);
  });
}

module.exports = { attach, accept };
