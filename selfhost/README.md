# Cursor Race — self-hosted

Runs the same `cursor-race.html` on your own domain. No npm dependencies: Node 18+ and
these files are the whole stack.

```bash
node build.js        # wrap the game into public/index.html
node server/index.js # http://localhost:8080
```

Or `npm start`, which does both.

## How it fits together

The game never talks to a network directly. Everything it needs from outside is reached
through `claude.use(name)`, which on claude.ai returns three runtime services. Off-platform
those don't exist, so `public/claude-shim.js` provides the same three namespaces over one
WebSocket to this server:

| `claude.use(...)` | used for | served by |
|---|---|---|
| `"room"` | live cursors, who is here, presence | WebSocket relay |
| `"db"` | the race schedule, profiles, results | JSON document store |
| `"user"` | which player you are | signed session cookie |

The game file is byte-identical to the one published as an artifact. `build.js` only wraps it
in the page skeleton claude.ai normally supplies and loads the shim ahead of it, so you can
keep developing in either place and copy the file across.

```
build.js                 wraps game/cursor-race.html -> public/index.html
game/cursor-race.html    the game, unmodified
public/claude-shim.js    the adapter: window.claude over a WebSocket
server/index.js          http + ws, race authority, ledger
server/ws.js             minimal RFC 6455 server
server/store.js          JSON document store (swap this for a real database)
server/game.js           rules the server and client must agree on
```

## Tables

The site is split into six tables, each capped at ten pilots, each running its own race on
its own channel. This is what lets the thing scale: presence is the hot path, and a single
global room means every cursor update reaches every player — n² traffic that is fine at ten
players and melts the server at a hundred. Scoping it to a table bounds the fan-out at
`TABLE_CAP²` no matter how busy the site gets.

Concretely:

- The **lobby room** holds everyone. Its presence carries only what the table list needs —
  name, colour, which table, whether that table is mid-race — and changes a few times a
  minute.
- A **table room** (`cursorrace-t3`) carries the race itself: cursors at ~20/s, distances,
  seats, bets. Only the players at that table receive it.
- Each table has its own round document (`live/t3`) and its own lease (`locks/t3`), so six
  races can be opening, running and settling independently.

The cap is enforced on the server in `joinRoom` — a client that asks for a full table is
refused with `limit_reached` — and shown in the picker so it rarely comes to that. Raise it
with `TABLE_CAP`, but remember the n² curve: ten is 100 messages per update cycle, thirty is
900.

To add tables, extend `TABLES` in the game file; the server derives the table id from the
room name and needs no list of its own.

## What the server decides, and what it doesn't

The split matters, so it is worth being exact.

**The server owns:**

- **The race clock.** A client asks to open a race; the server stamps `startsAt` from its own
  clock and writes the round document. Every client reads that one document, so the countdown
  and the start are the same for everyone regardless of how wrong their own clock is.
- **Credits.** The wallet lives in `wallets/<uid>` and is only ever moved by the server:
  −10 when it first sees you claim a seat, −stake when it sees a bet, +pot to the winner,
  +stake×field to a winning bet. Client writes of `credits` are stripped, writes to another
  player's drawer are refused, and `wallets/` is not writable at all.
- **Settlement.** The server resolves the round itself from presence, clamping each reported
  distance to what the race clock allows, and records the outcome in `results/<rid>`.

**The server does not own:**

- **Coins.** They buy cosmetics only, so the client reports them and the server stores them.
  If someone grants themselves a gold cursor, nothing of value moved.
- **Where your cursor is.** Positions are relayed, not refereed.

### The cheat that is still open

A modified client can report a distance it did not earn, up to the race clock's ceiling —
i.e. it can claim it survived when it actually hit a wall. It cannot claim to have flown
further than physically possible in the elapsed time, and it cannot touch anyone's wallet
directly, but it can win a pot it did not deserve.

Closing that means replaying the run: have the client stream its cursor positions, and on the
server regenerate the maze from the seed and check every sample against the walls and gates.
The maze functions are deterministic and seed-driven, so this is a port of `centerX`,
`halfW`, `gateAt` and `pillarsFor` into `server/game.js` plus a position log. Worth doing if
credits ever become worth anything; overkill for a game among friends.

## Deploying to a DigitalOcean droplet

Everything needed is in `deploy/`. The smallest droplet is plenty — this server shuffles
small JSON messages and does almost no CPU work. **Pick the region closest to your players**;
that choice matters more than the size of the box, because round-trip time is what the game
feels as lag.

### Once, on a fresh Ubuntu droplet

```bash
ssh root@your.droplet.ip
# copy deploy/ over, or clone the repo, then:
DOMAIN=play.example.com bash selfhost/deploy/setup.sh
```

`setup.sh` installs Node 22 and Caddy, creates the `cursorrace` system user, sets up
`/opt/cursor-race` and `/var/lib/cursor-race`, writes `/etc/cursor-race.env` with a generated
`SESSION_SECRET`, installs the systemd unit and Caddyfile, and opens 80/443 in ufw. Running
it twice is safe — it will not overwrite an existing env file.

Then point an A record at the droplet and add your Google credentials to
`/etc/cursor-race.env` if you want sign-in. Caddy gets the certificate on the first request.

### Every deploy, from your machine

```bash
bash selfhost/deploy/deploy.sh root@play.example.com
```

It builds `public/index.html`, tars the tree (excluding the data directory and logs), streams
it over ssh, syncs it into place, restarts the service and then **checks that the service came
back and is answering** — if it did not, it prints the last 30 journal lines and exits
non-zero rather than leaving you to discover it later. It needs only `ssh` and `tar` locally,
so it runs from Git Bash on Windows.

### Files

| | |
|---|---|
| `deploy/setup.sh` | one-time provisioning, run on the droplet |
| `deploy/deploy.sh` | ship and restart, run from your machine |
| `deploy/cursor-race.service` | systemd unit |
| `deploy/Caddyfile` | TLS and reverse proxy |
| `deploy/env.example` | the environment file, copied to `/etc/cursor-race.env` |

### Notes on the unit

The service runs as an unprivileged system user with `ProtectSystem=strict`, so the only
writable path is `/var/lib/cursor-race` — the store and session secret. Code in
`/opt/cursor-race` is read-only to it. `LimitNOFILE=65535` leaves room for sockets and
`MemoryMax=512M` keeps a leak from taking the box down. Logs go to the journal:

```bash
journalctl -u cursor-race -f
```

Caddy needs no WebSocket configuration — version 2 proxies upgrades as they are. It does set
`X-Forwarded-Proto`, which is how the server builds the right Google redirect URI; setting
`PUBLIC_URL` pins it regardless.

### Elsewhere

Fly.io, Railway, Render or any VPS work the same way: one Node process, one port, a proxy in
front that passes WebSocket upgrades. A static-only host (Pages, S3) can serve the game but
not the multiplayer, which needs a live socket.

### Environment

| variable | default | |
|---|---|---|
| `PORT` | 8080 | |
| `DATA_FILE` | `data/store.json` | where documents persist |
| `SESSION_SECRET` | generated into `data/secret` | set this in production |
| `JOIN_WINDOW` | 30000 | how long the gate stays open, ms |
| `ENTRY_FEE` | 10 | credits per seat |
| `START_CREDITS` | 100 | balance for a new player |
| `RESULT_HOLD` | 9000 | how long results stay up before the board clears |
| `TABLE_CAP` | 10 | pilots per table |
| `GOOGLE_CLIENT_ID` | — | set both to enable Google sign-in |
| `GOOGLE_CLIENT_SECRET` | — | |
| `PUBLIC_URL` | derived from the request | the origin Google redirects back to |

Short values are handy for testing: `JOIN_WINDOW=8000 RESULT_HOLD=3000 node server/index.js`.

## Swapping the store

`server/store.js` is deliberately small. Anything with `get`, `set`, `update`, `del`,
`acquire` and `onChange` can replace it — Postgres with `LISTEN/NOTIFY`, Redis with
pub/sub, Firestore. Two things to keep:

- `acquire` must be atomic across processes, or two players can open a race at once.
- `onChange` must fire for writes from *other* processes too, or clients behind a second
  instance will not see the round open.

Until then, run a single instance. The in-memory room has the same constraint: scaling past
one process needs the presence relay moved to Redis pub/sub.

## Accounts and Google sign-in

A visitor gets an anonymous `u_…` id in a signed, http-only cookie, which is enough for a
wallet to follow them across visits in one browser. Signing in with Google turns that into a
real account that follows them across devices.

### Setting it up

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials), create an
   **OAuth client ID** of type *Web application*.
2. Add your callback to **Authorised redirect URIs** — exactly, including the scheme:
   - `http://localhost:8080/auth/google/callback` for local work
   - `https://yourdomain.com/auth/google/callback` for the real thing
3. Fill in the OAuth consent screen (app name, support email). Until you publish it, only
   accounts you list as test users can sign in.
4. Run the server with the credentials:

```bash
GOOGLE_CLIENT_ID=...apps.googleusercontent.com \
GOOGLE_CLIENT_SECRET=... \
PUBLIC_URL=https://yourdomain.com \
NODE_ENV=production \
node server/index.js
```

`PUBLIC_URL` is what makes the redirect URI match behind a proxy; without it the server
builds one from the `Host` header and `X-Forwarded-Proto`. Leave the two Google variables
unset and sign-in simply switches off — the endpoints answer 503, the chip hides itself, and
everyone plays as a guest.

### How it behaves

- The chip sits bottom-left: *Playing as a guest · Sign in with Google*, or your name, picture
  and *Sign out*. It is part of the hosted page, not the game file, so the game stays
  identical to the artifact version.
- **A guest who signs in keeps their progress.** On first link the Google account adopts the
  anonymous session's own uid, so the wallet, coins and cursors carry over with nothing
  copied. Signing in again from another browser finds that same account.
- Sign out drops you to a fresh guest session; the account is untouched and waiting.

### What is checked

The flow is the authorization-code flow with `state` (CSRF) and `nonce`, both held in a
short-lived signed cookie scoped to `/auth`. The `id_token` arrives on the server's own TLS
call to Google's token endpoint, so the channel vouches for its signature — OIDC Core
3.1.3.7 lets a confidential client skip JWKS verification in this flow. The claims are still
checked, because that is what binds the token to *this* app: audience, issuer, expiry,
subject and nonce. `server/google.js` holds all of it.

`users/` and `identities/` are server-only: clients cannot read another player's account or
write either path.

### Other providers

`server/google.js` is the only Google-specific file. Any provider that ends with "here is a
stable subject id" slots into the same two steps in the callback: look up
`identities/<provider>:<sub>`, then set the session cookie to the uid it names.

## Updating the game

```bash
cp /path/to/new/cursor-race.html game/cursor-race.html
node build.js
```

If you change a pacing constant in the game (`V0`, `TA`, `VMAX`), change it in
`server/game.js` too — the server uses them to bound what a run can claim.

## Protocol

Client → server: `get` `set` `update` `del` `acquire` `watch` `unwatch` `presence` `emit`
`join` `leave`, each with an `id` that comes back on an `ack`. `presence` and `emit` take an
optional `room`; without one they act on the lobby.
Server → client: `ready` (peer id, uid), `peers` (a roster, with `room` when it is a table's),
`doc` (a watched document changed), `event` (a room topic), `ack`, `error`.

Document paths follow the Firestore rule the platform uses: an **even** number of segments is
a document, odd is a collection. That is why the round lives at `live/t3` and not
`tables/t3/round`, which would be a collection and throws.

Presence is the hot path and carries the whole object each time; the roster is coalesced and
broadcast on a 60 ms timer rather than per update.
