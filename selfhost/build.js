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
let game = lifted.html;
const title = (/<title>([^<]*)<\/title>/i.exec(game) || [, "Cursor Clash"])[1];

/* The tab icon has to be asked for from the head: Firefox takes an icon link
   wherever it finds one, Chrome only there, and the game's own markup lands
   in the body. So the link comes out of the game and goes up into the head,
   and the picture is also copied to public/favicon.png for the browsers that
   ask for /favicon.ico by name without reading the page at all. */
const iconTag = (/<link[^>]*rel="icon"[^>]*>\s*/i.exec(game) || [""])[0];
game = game.replace(iconTag, "");
const iconFile = (/href="(media\/[^"]+)"/.exec(iconTag) || [])[1];
if (iconFile) fs.copyFileSync(path.join(__dirname, "public", iconFile), path.join(__dirname, "public", "favicon.png"));

/* The pictures the first frame needs are asked for in the head, so they are
   on their way before the game has finished parsing. */
const preload = fs.readdirSync(MEDIA)
  .filter(f => /\.(webp|png|jpg|gif|svg)$/.test(f))
  .map(f => '<link rel="preload" as="image" href="media/' + f + '">')
  .join("\n");

/* Google Analytics, on the hosted page only: the artifact lives inside
   claude.ai and is nobody's site to measure. */
const GA_ID = "G-PMSSLJK69Q";
const GA_TAG =
  '<!-- Google tag (gtag.js) -->\n' +
  '<script async src="https://www.googletagmanager.com/gtag/js?id=' + GA_ID + '"></script>\n' +
  '<script>\n' +
  '  window.dataLayer = window.dataLayer || [];\n' +
  '  function gtag(){dataLayer.push(arguments);}\n' +
  "  gtag('js', new Date());\n" +
  "  gtag('config', '" + GA_ID + "');\n" +
  '</script>\n';

/* What a search engine and a link preview read. One canonical address for
   both servers, so the mirror in the States is not indexed as a copy of the
   first; and a description that says what the game is, since without one
   the engine quotes whatever text it finds in the page. */
const SITE = "https://cursorclash.com/";
const TAGLINE = "Cursor Clash - last cursor standing";
const DESCRIPTION = "Free multiplayer browser game: steer your mouse cursor down a narrowing channel against your friends. " +
  "Last cursor standing wins the pot. No download, no account needed.";
const SEO =
  '<meta name="description" content="' + DESCRIPTION + '">\n' +
  '<link rel="canonical" href="' + SITE + '">\n' +
  '<meta name="theme-color" content="#040a20">\n' +
  '<meta property="og:type" content="website">\n' +
  '<meta property="og:site_name" content="Cursor Clash">\n' +
  '<meta property="og:title" content="' + TAGLINE + '">\n' +
  '<meta property="og:description" content="' + DESCRIPTION + '">\n' +
  '<meta property="og:url" content="' + SITE + '">\n' +
  '<meta property="og:image" content="' + SITE + 'og.jpg">\n' +
  '<meta property="og:image:width" content="1200">\n' +
  '<meta property="og:image:height" content="630">\n' +
  '<meta name="twitter:card" content="summary_large_image">\n' +
  '<meta name="twitter:title" content="' + TAGLINE + '">\n' +
  '<meta name="twitter:description" content="' + DESCRIPTION + '">\n' +
  '<meta name="twitter:image" content="' + SITE + 'og.jpg">\n';

/* What a phone puts on the home screen. The tab icon is only the crowned
   cursor, since the name is unreadable at sixteen pixels; the home screen
   gets the whole logo. iOS reads the touch icon (and asks for it by name
   even without the tag), Android reads the manifest. The manifest keeps the
   browser around it - "browser", not "standalone" - so signing in with
   Google goes on working the way it does in a tab. */
const HOME_ICON =
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png">\n' +
  '<link rel="manifest" href="/site.webmanifest">\n' +
  '<meta name="apple-mobile-web-app-title" content="Cursor Clash">\n';

const page =
  "<!doctype html>\n<html lang=\"en\">\n<head>\n" +
  "<meta charset=\"utf-8\">\n" +
  "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n" +
  "<title>" + TAGLINE + "</title>\n" +
  SEO +
  iconTag.trim() + "\n" +
  HOME_ICON +
  GA_TAG +
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
