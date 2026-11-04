# The Referral Rush

A phone-based classroom game about referrals and hiring. Players get roles, send referrals and accept jobs on their phones, and negotiate **in person**. The facilitator controls the pace: there are no timers and no automatic phase changes.

**Phases:** Lobby → Role reveal → Networking → Hiring → Results → Discussion. Only the host moves forward.

## Run it

Requires **Node.js 22.13 or newer**. It uses Node's built-in SQLite, and its only dependency is `qrcode`.

```bash
npm install
npm start          # http://localhost:3000
npm test           # automated tests
```

The game state is stored in `data/referral-rush.db`. To change the location, set `DB_FILE`.

### In a classroom, on one laptop

1. Connect the laptop and the students' phones to the same Wi-Fi.
2. Run `npm start`. The terminal prints a **Same Wi-Fi** address, such as `http://192.168.1.20:3000`.
3. On the laptop, open that address (not `localhost`) and choose **Host a new game**. The QR code and join link point to that address.
4. Show the room code and QR code on the projector. Keep the **Private** section closed while projecting.

Some school and guest networks block devices from reaching each other. If phones can't load the page, host it online instead (below).

### Hosting online

This is a single Node process, so any Node host works. It needs:

| Setting | Value |
|---|---|
| Build command | `npm install` |
| Start command | `npm start` |
| `PORT` | set automatically by most hosts |
| `TRUST_PROXY` | `1` behind the host's HTTPS proxy (adds the `Secure` cookie flag, uses real client IPs) |
| `PUBLIC_URL` | optional, e.g. `https://referral-rush.example.com`, to fix the join link and QR code |
| `DB_FILE` | optional, a path on a persistent disk |

Notes:

- **Render, Railway or Fly.io:** create a web service from this GitHub repo using the settings above.
- **Run one instance only.** Live updates are kept in memory, so the app should not be scaled to more than one instance.
- **Free tiers that sleep or wipe the disk** are fine for a single class session. They lose any game left idle between sessions. Attach a persistent disk and point `DB_FILE` at it if you want games to survive restarts.
- Rooms are deleted automatically after 48 hours of inactivity.

## How to run a session

- **Host:** open the site, choose **Host a new game**, and share the code or QR code. Wait for at least 3 players (6 or more is best), then press **Assign roles**. After that, one button always names the next step. Before you close hiring, the host screen warns you about unfilled positions.
- **Players:** scan the QR code or enter the room code and a name. No account is needed. **Home** and **Rules** are always at the bottom of the screen.
- **Late arrivals** join as spectators and see only public information. They become players after a **Reset**.
- **A player switches phone or browser:** open **Players and rejoin codes** on the host screen and give them a code. On the join page they open **Already joined on another phone?** and enter it. Codes work once and expire after 15 minutes.
- **Running the game from a second device:** use **Run the game from another device** to copy the private host link. Anyone with that link can control the game.

## Game rules

- **Every player is an employer** (A, B, C … then AA, AB … for big rooms). The game needs at least 3 players; 6 or more is best.
- **The candidate bank** is run by the computer: 4 candidates per player (10 players → 40 candidates), each with a made-up name and a secret score from 1 to 10. Scores are spread across the range and balanced between files; IDs, files and scores come from independent shuffles.
- **Private files:** each employer privately sees the true scores of 4 candidates, and **cannot hire anyone in their own file**.
- **Networking:** referrals are optional and unlimited. An employer can refer any candidate from their file to any other employer (one slip can go to several employers at once). The server attaches the true score; referrals cannot be edited or withdrawn, and the same candidate can't be sent to the same employer twice.
- **Hiring:** each employer fills **2 positions**. Tapping Hire on an available candidate outside your file hires them instantly, first come first served, and the hire is final. Simultaneous attempts on one candidate produce exactly one winner.
- **Scoring:** an employer's score is the sum of their hires' scores; empty positions score 0. The highest total wins, and ties share the win. Before results, hire scores stay hidden unless a referral revealed them; afterwards everyone sees employer totals, each employer sees their own hires' scores, and individual scores are never published to everyone.
- The host is warned about open positions before closing hiring.

## Security model

All rules run on the server. The browser only displays what the server sends to that viewer.

- **Sessions:** players and hosts each get a separate random token in an `HttpOnly`, `SameSite=Lax` cookie scoped to one room; only SHA-256 hashes are stored. A room code lets someone join, nothing more. Host access needs the host cookie or the private host key.
- **What each viewer receives:** every response is built for the specific viewer (employer, observer or host). An employer receives scores only for their own file and for referrals sent to them, until the results. Scores are never sent and then hidden. The live-update stream carries only a version number.
- **Validating actions:** each action is checked inside a database transaction together with the current phase, so a hire attempted after hiring closes fails even from a stale screen. A hire is a conditional update that only succeeds if the candidate is still free. SQLite triggers re-check the rules: phase, truthful referrals from your own file only, valid recipients, no own-file hires, at most 2 hires, no double hires, finality, and phase order. Every action carries a request ID, and a replayed request returns the stored result instead of running twice.
- **Other protections:** write requests need a custom header and a JSON body (CSRF protection); the Content Security Policy blocks inline scripts and styles; joining, rejoining and room creation are rate-limited; logs record only method, path and status.

## What was tested

**Automated tests** (`npm test`, 25 tests, all passing) drive the real HTTP server with a separate cookie jar per simulated phone:

- **Setup:** role assignment for every attendance count from 3 to 80 (labels continue past Z to AA), bank size of 4 per player, files of 4, 2 hires each, balanced and unpredictable scores; full API games with 3, 4, 6, 9, 15, 27 and 30 players.
- **Privacy:** every employer's state scanned for scores — only their own file plus referrals they received, all true values; observers and strangers get none; no other employer's file membership leaks.
- **Isolation and forged requests:** cookies copied between rooms don't work; forged sender, label, player ID or score fields are ignored; referring outside your file, to yourself or to a non-employer is rejected; old employee-era actions no longer exist.
- **Referrals:** one employer sending all 4 candidates to all 4 rivals (16 referrals) succeeds; duplicates are rejected; recipients see true scores; referrals are optional (no warnings) and closed outside Networking.
- **Hiring:** own-file hires blocked; instant first-come hiring; third hire rejected; no way to undo; scores hidden until results unless referred.
- **Concurrency and replays:** 14 simultaneous attempts on one candidate produce exactly one hire; a burst of 10 hires by one employer produces exactly 2; replayed referrals, hires and phase changes are not applied twice.
- **Phase races:** a hire racing "close hiring" either lands before results or fails, never after.
- **Results:** exact totals, a two-way tie, sorting, and visibility rules after the reveal.
- **Sessions and plumbing:** refresh, single-use rejoin codes that revoke the old session, host-only endpoints, live-update stream, security headers, path traversal, rate limiting, reset, and database triggers that block invalid writes even when app code is bypassed.

**Manual browser check** (Chrome, one host and three employers in separate tabs): role reveal and private file, a referral sent to two employers with one confirmation, instant hiring with the HIRED stamp, a rival's attempt on the same candidate rejected, the close-hiring warning, and results where one strong hire beat two weaker ones.

**Not tested:** real phones, a real classroom network, screen readers, the reduced-motion setting itself, and rooms larger than 30 players over the API.
