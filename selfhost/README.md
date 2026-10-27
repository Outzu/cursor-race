# Cursor Clash — self-hosted

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

## Two currencies

**Coins** are earned one per gate cleared. They pay the 10-coin race entry, form the winner's
pot, and buy cursor designs.

**Gems** are picked up on the channel. They appear in the corridor — some scrolling in from
the top, some blinking into existence already in view — and the first cursor to touch one
takes it. They buy tails, and nothing else.

Gems are seeded from the round id like the rest of the course, so every pilot sees the same
gems in the same places; what differs is who gets there first. A claim is broadcast on the
table's room and the relay delivers it in one order to everyone, so the first claim back is
the winner on every screen without anyone arbitrating.

**Practice runs pay nothing.** No coins, no gems, no entry, no pot — they exist to learn the
channel, not to farm it.

**Cursors and tails are bought, not unlocked.** A locked one shows a lock and its price; tap
it and the line under the grid becomes the till. Buying spends the currency, so the ladder is
a choice rather than a threshold you drift past. Only a signed-in account may buy: a guest
sees "sign in with google to buy", and the server keeps whatever `owned` it already holds for
a player with no account rather than taking the client's word for it.

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
  seats. Only the players at that table receive it.
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
- **Every coin that moves between players.** `wallets/<uid>` holds the server's running
  ADJUSTMENT, not a balance: −10 when it first sees you claim a seat, +pot to the winner.
  What a player is shown is
  `coins they report earning + that adjustment`. A read adds it on and a write takes it back
  off, so the two halves never double-count, and the zero-sum flows stay the server's alone
  even though earning happens on the client. Writes to another player's drawer are refused
  and `wallets/` is not writable at all.
- **Settlement.** The server resolves the round itself from presence, clamping each reported
  distance to what the race clock allows, and records the outcome in `results/<rid>`.

**The server does not own:**

- **How many coins and gems you earn.** Gates and gem pickups are counted on the client.
  Inflating them buys cursors and tails you did not earn, and lets you pay entry fees you did
  not earn — the pot is the seats, so the damage per race is bounded by the entry fee.
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
coins ever become worth anything; overkill for a game among friends.

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
| `ENTRY_FEE` | 10 | coins per seat |
| `START_COINS` | 100 | coins for a new player |
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

The in-memory room has the same constraint: a second instance *serving the same tables*
needs the presence relay moved to Redis pub/sub. A second instance serving its own tables
does not — see below.

## A second region

A race is a place; an account is an account. Those pull in opposite directions, so the store
is split down the middle by path:

| shared between regions | belongs to the server running it |
| --- | --- |
| `wallets/<uid>` — coins and gems | `live/<table>` — the round that table is running |
| `users/<uid>` — the account | `locks/<table>` — who may open a race |
| `identities/google:<sub>` | the in-memory peers, rooms and presence relay |
| `data/users/<uid>/profile` | |
| `board/top`, `results/…` | |

`SplitStore` in `server/store.js` routes on the prefix, so neither half knows the other
exists. With no `DATABASE_URL` both halves are the same JSON file and nothing changes —
that is what a single region gets, and it is all most deployments need.

Set `DATABASE_URL` on two servers pointing at one Postgres and they share accounts while
keeping their own races. Players reach whichever server is nearer and meet the people
already there; nobody races across an ocean, because at ~90 ms the player further from the
server would lose every contested gem to the relay, which is unfairness rather than lag.

Both servers must share `SESSION_SECRET`, or the same person is two different accounts —
the Google `sub` → uid mapping lives in `identities/`, and a cookie signed by one server
must verify on the other. Each still needs its own `PUBLIC_URL` registered in the Google
console.

`server/pgstore.js` holds the shared half in memory and serves reads from there, because
the rest of the server reads documents synchronously mid-frame and cannot wait on a query.
Writes go to Postgres behind that, and a poll every few seconds brings back what the other
region changed. Balances are the exception: those are added up by the database itself
(`GREATEST(0, coins + $delta)`), so two regions charging the same player cannot lose a
delta between reading a balance and writing it back.

`npm test` covers the split and the arithmetic against an in-memory Postgres.

### Sending players to the nearer one

The page does it, by measuring. `REGIONS` lists every server as `id|name|origin`; each
answers `/api/ping` from any origin, so the browser times all of them, starts a first-time
visitor on the quickest, and puts the list behind the signal meter in the corner with a
live figure against each. Choosing one is remembered and honoured from then on — a player
who prefers a busier table over a nearer server gets to keep that.

Measuring beats geography: an address can place someone correctly and still be wrong about
which server answers them fastest, and this needs no GeoIP database to go stale. A region
only wins the automatic choice if it is more than 40 ms better, since below that the
reload costs more than it saves, and the decision to *stay* is recorded as firmly as the
decision to move — otherwise the next load reads a faster-on-paper region back and reloads
for a difference already dismissed.

The choice travels as `?region=<id>` because localStorage does not cross a domain. Neither
does a cookie: `play.example.com` and `us.example.com` are different hosts, so without
`COOKIE_DOMAIN` set to the parent each would hand the same player a different id and
sharing `SESSION_SECRET` would achieve nothing.

With `REGIONS` unset there is no picker and nothing is measured, which is what a
single-region deployment should look like.

### Moving an existing server onto the shared store

`tools/migrate-to-shared.js` copies wallets, accounts, identities, profiles and the board
out of the JSON file and into Postgres, leaving `live/` and `locks/` behind. Run it **before**
setting `DATABASE_URL` on a server that already has players: the moment that variable is
set, accounts are read from the database, and an empty one makes every player look new.
It reports what it would move and writes nothing until given `--go`.

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
