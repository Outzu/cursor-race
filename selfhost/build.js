"use strict";
/* Wraps the artifact game file in the page skeleton claude.ai normally supplies,
   and loads the shim ahead of it. Run this after copying a new version of the
   game into game/cursor-race.html. */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SRC = path.join(__dirname, "game", "cursor-race.html");
const OUT = path.join(__dirname, "public", "index.html");
const MEDIA = path.join(__dirname, "public", "media");

/* The artifact has to carry its pictures and sounds inside it, because there
   is no server there to fetch them from. Here there is one, and carrying them
   inline is expensive in a way that is easy to miss: three quarters of that
   file is base64 of things that are already compressed, so it does not gzip -
   750 KB only squeezes to 474 KB - and the page is served no-cache, so every
   visit pulls the lot again.

   So the hosted build takes them back out. Each one is named by a hash of its
   own contents, which means it can be cached for ever and a changed file is
   simply a different name. What is left is the game, which does compress. */
const EXT = {
  "image/webp": ".webp", "image/png": ".png", "image/jpeg": ".jpg",
  "image/svg+xml": ".svg", "image/gif": ".gif",
  "audio/mpeg": ".mp3", "audio/ogg": ".ogg", "audio/wav": ".wav",
  "font/woff2": ".woff2"
};

function liftMedia(html) {
  fs.rmSync(MEDIA, { recursive: true, force: true });   // names are hashes, so stale ones only pile up
  fs.mkdirSync(MEDIA, { recursive: true });
  const seen = new Map();
  let saved = 0, kept = 0;
  const out = html.replace(/data:([a-z]+\/[a-z0-9+.-]+);base64,([A-Za-z0-9+/=]+)/gi,
    (whole, mime, b64) => {
      const ext = EXT[mime.toLowerCase()];
      if (!ext) { kept++; return whole; }              // nothing to gain, leave it be
      let name = seen.get(b64);
      if (!name) {
        const bytes = Buffer.from(b64, "base64");
        name = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16) + ext;
        fs.writeFileSync(path.join(MEDIA, name), bytes);
        seen.set(b64, name);
      }
      saved += whole.length - ("media/" + name).length;
      return "media/" + name;
    });
  return { html: out, files: seen.size, saved, kept };
}

const SKELETON_CSS =
  ':root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}' +
  'body{margin:0;font:14px system-ui,-apple-system,"Segoe UI",sans-serif}' +
  'img{max-width:100%}[hidden]{display:none!important}';

/* the account chip belongs to the hosted page, not the game */
const ACCOUNT_CSS =
  '#account{position:fixed;left:max(14px,env(safe-area-inset-left,0px));bottom:max(14px,env(safe-area-inset-bottom,0px));' +
  'z-index:70;display:flex;align-items:center;gap:9px;padding:7px 9px 7px 7px;border-radius:999px;' +
  'background:#0c1324;box-shadow:inset 0 0 0 1px #27375a;font:12px "Azeret Mono",ui-monospace,monospace;color:#8b99bb}' +
  'body.focus #account,body.settings #account{display:none}' +
  '#account.inline{position:static;margin:2px auto 0}' +
  '#account img{width:22px;height:22px;border-radius:50%;display:block}' +
  '#account .dot{width:9px;height:9px;border-radius:50%;background:#4d5c80;margin-left:4px}' +
  '#account .nm{max-width:22ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#eef2fb}' +
  '#account .nm.guest{color:#8b99bb}' +
  '#account .act{color:#3fe0cf;text-decoration:none;letter-spacing:.08em;text-transform:uppercase;font-size:10px;' +
  'padding:4px 9px;border-radius:999px;box-shadow:inset 0 0 0 1px #27375a}' +
  '#account .act:hover{background:rgba(63,224,207,.12)}' +
  /* the chip's own look, only roomier and with the mark in front */
  '#account .act.primary{display:inline-flex;align-items:center;gap:10px;' +
  'font-size:12px;padding:12px 18px;line-height:1}' +
  '#account .gicon{width:20px;height:20px;display:block}' +
  /* a phone has no room for the chip's caption beside a full-size button */
  '@media (max-width:560px){#account{gap:7px;padding:5px 7px 5px 5px;max-width:calc(100vw - 24px)}' +
  '#account.inline{width:100%;justify-content:center}' +
  '#account .nm.guest{display:none}' +
  /* with the caption gone the pill is just a frame round the button */
  '#account:has(.act.primary){background:none;box-shadow:none;padding:0}' +
  '#account .act.primary{font-size:11px;padding:12px 14px;gap:8px}}' +
  '#signin-failed{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:80;' +
  'background:#1b2740;color:#ff5470;padding:10px 16px;border-radius:4px;' +
  'font:12px "Azeret Mono",ui-monospace,monospace}';

const raw = fs.readFileSync(SRC, "utf8");
const lifted = liftMedia(raw);
const game = lifted.html;
const title = (/<title>([^<]*)<\/title>/i.exec(game) || [, "Cursor Clash"])[1];

/* The pictures the first frame needs are asked for in the head, so they are
   on their way before the game has finished parsing. */
const preload = fs.readdirSync(MEDIA)
  .filter(f => /\.(webp|png|jpg|gif|svg)$/.test(f))
  .map(f => '<link rel="preload" as="image" href="media/' + f + '">')
  .join("\n");

const page =
  "<!doctype html>\n<html lang=\"en\">\n<head>\n" +
  "<meta charset=\"utf-8\">\n" +
  "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n" +
  "<title>" + title + "</title>\n" +
  "<style>" + SKELETON_CSS + ACCOUNT_CSS + "</style>\n" +
  preload + "\n" +
  "</head>\n<body>\n" +
  "<script src=\"claude-shim.js\"></script>\n" +
  game.replace(/<title>[^<]*<\/title>\s*/i, "") +
  "\n<div id=\"account\" hidden></div>\n" +
  "<script src=\"account.js\"></script>\n" +
  "</body>\n</html>\n";

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, page);
const mediaBytes = fs.readdirSync(MEDIA)
  .reduce((a, f) => a + fs.statSync(path.join(MEDIA, f)).size, 0);
console.log("built " + path.relative(process.cwd(), OUT) + " (" + (page.length / 1024).toFixed(1) + " KB)" +
  " + " + lifted.files + " media files (" + (mediaBytes / 1024).toFixed(1) + " KB, cached for ever)" +
  (lifted.kept ? " [" + lifted.kept + " left inline]" : ""));
