# The Referral Rush

A phone-based classroom game about referrals and hiring. Players get roles, send referrals and accept jobs on their phones, and negotiate **in person**. The facilitator controls the pace: there are no timers and no automatic phase changes.

**Phases:** Lobby → Role reveal → Networking → Hiring → Results → Discussion. Only the host moves forward.

## Run it

Requires **Node.js 22.13 or newer**. It uses Node's built-in SQLite, and its only dependency is `qrcode`.

```bash
npm install
npm start          # http://localhost:3000
npm test           # 29 automated tests
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

- **Host:** open the site, choose **Host a new game**, and share the code or QR code. Wait for at least 6 players (9 or more is best), then press **Assign roles**. After that, one button always names the next step. Before you advance, the host screen warns you about missing referrals, unfilled positions and pending offers.
- **Players:** scan the QR code or enter the room code and a name. No account is needed. **Home** and **Rules** are always at the bottom of the screen.
- **Late arrivals** join as spectators and see only public information. They become players after a **Reset**.
- **A player switches phone or browser:** open **Players and rejoin codes** on the host screen and give them a code. On the join page they open **Already joined on another phone?** and enter it. Codes work once and expire after 15 minutes.
- **Running the game from a second device:** use **Run the game from another device** to copy the private host link. Anyone with that link can control the game.

## Game rules

- There are 3 employers (A, B and C). Every other player is an employee (E1, E2, …), and there are E employees in total.
- **Hires and referrals per employer:** H = max(1, floor(E / 5)).
- Employees are split into three information groups as evenly as possible, one group per employer. An employer sees their own group's scores but **cannot hire from it**.
- **Scores:** each employee has a secret score from 1 to 10. Scores are spread across the range and roughly balanced between groups. Employee IDs, groups and scores come from separate shuffles, so an ID says nothing about its score.
- **Networking:** each employer must send H referrals, each about a different employee in their group, to either rival employer. The server attaches the true score. A sent referral cannot be edited or withdrawn.
- **Hiring:** employers make offers and employees accept or decline.
  - A pending offer reserves one of the employer's H positions.
  - An employer can withdraw a pending offer, which frees the position.
  - Acceptance is final, and it closes the employee's other offers.
  - Closing hiring expires any offers still pending.
- **Scoring:** an employer's score is the sum of their hires' scores. Unfilled positions score 0. The highest total wins, and ties share the win.

## Security model

All rules run on the server. The browser only displays what the server sends to that viewer.

**Sessions**
- Players and hosts each get a separate random token in an `HttpOnly`, `SameSite=Lax` cookie scoped to one room. The database stores only SHA-256 hashes of these tokens.
- A room code lets someone join, nothing more. Host access needs the host cookie or the private host key.

**What each viewer receives**
- Every response is built for the specific viewer: player, employer, employee, spectator or host.
- Scores the viewer may not see are never sent, not even hidden on the page.
- The live-update stream carries only a version number. Each client then fetches its own authorized view.

**Validating actions**
- Each action is checked inside a database transaction, together with the current phase. An offer accepted after hiring closes therefore fails, even from a stale screen.
- SQLite triggers and unique indexes check the same rules again: phase, referral limits, offer capacity, own-group hires, one accepted job per employee, finality, and the phase order.
- Every action carries a request ID. A replayed request returns the stored result instead of running twice.

**Other protections**
- Write requests need a custom header and a JSON body (CSRF protection).
- The Content Security Policy blocks inline scripts and inline styles.
- Joining, rejoining and room creation are rate-limited.
- Logs record only the method, path and status code.

## What was tested

**Automated tests** (`npm test`, 29 tests; all pass). They drive the real HTTP server, and each simulated phone has its own cookie jar.

- **Roles and limits:**
  - Role assignment for every attendance count from 6 to 60, plus full API games with 6, 7, 8, 9, 10, 14, 15, 17, 18, 24 and 30 players.
  - Group sizes, including uneven ones (17 players gives groups of 5, 5 and 4). Hire limits for 9, 15, 18 and 24 players match the spec.
  - Score spread and balance, and no predictable mapping from ID to score or group.
- **Privacy:**
  - Every player's state was scanned for scores. Employees get none before results. Employers get exactly their own group plus referrals they received.
  - Strangers and spectators get no scores. Page HTML contains no game data.
- **Isolation and forged requests:**
  - Cookies copied between rooms don't work, and a host can't act on another room.
  - An offer ID from another room returns "not found".
  - Forged role, label, player ID or score fields in the request body are ignored. The backend's score is always used.
- **Referrals:** phase gating, limit of H, no duplicates, only your own group, only a rival as recipient. Sender, recipient, host and the referred employee each see exactly their own view.
- **Hiring:**
  - Phase gating, no hires from your own group, capacity counts pending offers, declining or withdrawing frees a position.
  - Only the owner can withdraw, only the recipient can accept, and an employee who is already hired can't receive offers.
- **Concurrency:**
  - Four simultaneous accept requests across two offers produce exactly one job.
  - 14 simultaneous offers with H = 4 produce exactly 4.
  - Six simultaneous duplicate offers produce one.
- **Replays and stale actions:**
  - Replayed referrals and replayed phase changes are not applied twice.
  - A stale "advance" from an old phase is rejected instead of skipping a phase.
- **Phase-change races:** acceptance racing "close hiring" (5 rounds), plus a deterministic acceptance after close, which is rejected. No offers are left pending after results.
- **Results:**
  - Exact totals and a two-way tie with fixed scores, and a single winner.
  - Nothing is revealed before Results. Afterwards employees see their own score and outcome, and employers see their hires' scores. No individual score is shown to everyone.
- **Sessions and host access:**
  - Refreshing keeps your identity. A rejoin code works once, and it revokes the old session.
  - Players and strangers can't reach host endpoints, and forged host cookies or wrong host keys are rejected.
- **Database and HTTP:**
  - Database triggers block invalid writes even when the app code is bypassed.
  - The live-update stream requires a session and carries only a version number.
  - Security headers, path traversal, rate limiting, and reset confirmation.

**Manual browser check** (Chrome, one host plus 12 simulated phones; dark mode, and light mode on the results screen):

- I played one full game through every phase as the host, as Employer A and as an employee. I claimed both player seats with rejoin codes.
- Checked: live updates, the card flip, referral confirmation, offers and the pending-slot limit, accepting with confirmation, the close-hiring warning, a tie result, Discussion, and Rules showing the room's limits.
- At a simulated 360px width there was no horizontal overflow.
- That pass found and fixed several layout bugs, including progress bars broken by the Content Security Policy.

**Not tested:**

- Real phones, iOS Safari, or Android.
- A real classroom network, or a deployed host.
- Screen readers, and pressing Enter to submit a form. The automation tool's Enter key did not submit, but clicking the button did.
- The reduced-motion styles. They are in the CSS but weren't exercised.
- Loads larger than about 30 players per room.
