"use strict";
/* Wraps the artifact game file in the page skeleton claude.ai normally supplies,
   and loads the shim ahead of it. Run this after copying a new version of the
   game into game/cursor-race.html. */

const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "game", "cursor-race.html");
const OUT = path.join(__dirname, "public", "index.html");

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

const game = fs.readFileSync(SRC, "utf8");
const title = (/<title>([^<]*)<\/title>/i.exec(game) || [, "Cursor Race"])[1];

const page =
  "<!doctype html>\n<html lang=\"en\">\n<head>\n" +
  "<meta charset=\"utf-8\">\n" +
  "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n" +
  "<title>" + title + "</title>\n" +
  "<style>" + SKELETON_CSS + ACCOUNT_CSS + "</style>\n" +
  "</head>\n<body>\n" +
  "<script src=\"claude-shim.js\"></script>\n" +
  game.replace(/<title>[^<]*<\/title>\s*/i, "") +
  "\n<div id=\"account\" hidden></div>\n" +
  "<script src=\"account.js\"></script>\n" +
  "</body>\n</html>\n";

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, page);
console.log("built " + path.relative(process.cwd(), OUT) + " (" + (page.length / 1024).toFixed(1) + " KB)");
