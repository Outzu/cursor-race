"use strict";
/* Durable JSON document store. Small on purpose: swap this file for Postgres,
   Redis or Firestore by keeping the same five methods plus onChange. */

const fs = require("fs");
const path = require("path");

class Store {
  constructor(file) {
    this.file = file;
    this.docs = {};
    this.leases = {};
    this.subs = new Set();
    this.timer = null;
    try {
      this.docs = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      this.docs = {};
    }
  }

  get(p) { const d = this.docs[p]; return d ? d.body : null; }
  version(p) { const d = this.docs[p]; return d ? d.v : 0; }

  set(p, body) {
    this.docs[p] = { body, v: this.version(p) + 1, at: Date.now() };
    this.changed(p);
  }

  update(p, patch) { this.set(p, Object.assign({}, this.get(p) || {}, patch)); }

  del(p) { delete this.docs[p]; this.changed(p); }

  list(prefix) { return Object.keys(this.docs).filter(k => k.startsWith(prefix)); }

  /* cooperative lease, used so two players cannot open a race at once */
  acquire(p, holder, ttlMs) {
    const now = Date.now();
    const cur = this.leases[p];
    if (cur && cur.until > now && cur.holder !== holder) {
      return { acquired: false, expiresAt: new Date(cur.until).toISOString() };
    }
    const until = now + Math.max(1000, Math.min(600000, ttlMs || 30000));
    this.leases[p] = { holder, until };
    return { acquired: true, holder, expiresAt: new Date(until).toISOString() };
  }

  onChange(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }

  changed(p) {
    for (const fn of this.subs) {
      try { fn(p, this.get(p)); } catch (e) { console.error("store subscriber:", e.message); }
    }
    this.save();
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file + ".tmp", JSON.stringify(this.docs));
        fs.renameSync(this.file + ".tmp", this.file);
      } catch (e) {
        console.error("store save failed:", e.message);
      }
    }, 250);
  }
}

module.exports = { Store };
