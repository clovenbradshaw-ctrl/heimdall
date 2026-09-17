# heimdall

Distributed local inference. You get a link. Anyone who opens it and presses
**Accept** turns their phone or laptop into a compute node you manage
collectively. Their device downloads a small model, runs it locally in the
browser, and streams answers back to you.

No accounts to create for workers, no server to rent, no data ever stored on a
central server.

- **Matrix** (hyphae.social) — a room is created per fleet. The room is *only* a
  directory: it holds the members so peers can find each other and exchange
  encrypted signaling. It is not a message channel and nothing you compute ever
  lives there.
- **WebRTC** — offers/answers/ICE travel as encrypted Matrix *to-device* events
  (ephemeral, not stored in the room). Once the DataChannel is up, prompts,
  tokens, and results flow device-to-device directly.
- **WebLLM** — each worker runs a local LLM in its own browser tab via WebGPU.
  Models are cached on-device after the first download.

## Try it

1. Open the deployed site. Enter the name you want workers to see, click **Create fleet room**.
2. Copy the share link — it names you (your Matrix id + display name), carries an expiry, and sends it to anyone.
3. They open it and see **who is asking**, their own **public IP**, and the invite's remaining time.
4. You tell them the 6-digit code (not in the link); they enter it, the code is
   confirmed by you live, they press **Accept compute duties**, pick a model size.
5. Back on your screen they appear under **Workers**, with a countdown on their lease.

Every device that presses accept auto-creates a throwaway Matrix account on
hyphae.social (a single `m.login.dummy` registration step — no email, no
captcha). If you'd rather use your own Matrix account, the sign-in card is at
the bottom of the page.

## Trust & time

The handshake is consent-first, and everything is time-bound:

- **Who is asking.** The link carries the host's Matrix id and display name.
  After the worker joins, the room's `m.room.create` event is cross-checked
  against the claim: if the room wasn't created by the account the link names,
  the worker sees a hard warning.
- **Their own exposure.** Before accepting, the worker is shown its own public
  IP and told that the host will see that IP and the device type once connected.
- **A 6-digit secret code, 2FA style.** Every invite has a code the host
  generates and shares out-of-band (voice, chat, in person). The code never
  rides in the link, and accepting requires it: the worker sends only a hash of
  the code over the encrypted channel and the host confirms it live. A stolen
  link alone is worthless, and the host refuses wrong codes. A device that the
  host has confirmed once is remembered, so lease renewals don't re-ask.
- **Accounts.** Each device auto-creates its own account on hyphae.social, and
  a device that's already signed in reuses its own session. Crypto state is
  stored per account in IndexedDB (scoped via `cryptoDatabasePrefix`), so
  switching accounts — or another Matrix app on the same origin — never
  triggers the shared-store mismatch error. The account can be **claimed** with
  a real password and reused to log in from other devices, and is what the fold
  will accept.
- **Leases.** An invite expires after **7 days** (host renews it with one
  click). An accepted lease runs **12 hours**; when it lapses the worker stops
  answering and the host is prompted to nudge them. Renewal is a fresh accept,
  on the worker's side, by their own hand.

## Inference is mutual

There are no passive members. The fleet keeps a ledger and **no one borrows
without giving**:

- **Giving** = serving a job. The host's "Run" jobs and other workers' borrows
  both count as jobs a node completes.
- **Borrowing** = requesting a job. Any worker can ask the fleet for compute
  (`job` → the host routes it to a ready giver, tokens stream back).
- **Credit = gave − took.** A node may only borrow while its credit is above
  zero, so a new node must serve compute before it can take any. The host
  enforces this at the router, and the credit number is broadcast back to each
  node so the meter is visible.
- **The host gives too.** "Lend my device" loads a model in the host's own tab
  and makes it a giver, so the host earns credit back to the fleet instead of
  only drawing from it.

## Also get the fold up and running

The same page that hands out the compute link doubles as the fold's door:

- **Try it in this browser** — `https://clovenbradshaw-ctrl.github.io/the-fold/`
  (static build, WebGPU in-tab models, no install).
- **Run it locally** — `git clone https://github.com/clovenbradshaw-ctrl/the-fold.git && cd the-fold && ./fold`
  → opens `http://localhost:8811`. Needs git + Node ≥ 20.11; the script
  installs Ollama (`gemma2:2b`) for you.

## Generate invites from any surface

Invites are minted by a single shared function (`src/invite.js` →
`createInvite`), and the 6-digit codes live in the controller account's
account data — so every surface signed into that account can issue *and*
confirm codes.

- **This site.** Controller mode → Create fleet room → copy link + code.
- **Any terminal.** `npx --yes github:clovenbradshaw-ctrl/heimdall invite`
  prints the link and code, and remembers the session in `~/.heimdall/state.json`.
  Options: `--name "Your Name"`, `--room !id:hs` (reuse a fleet), `--new`,
  `--user @me:hs --password …` (use your own account), `--hs URL`. Also
  `heimdall login` and `heimdall reset`. Set `HEIMDALL_SITE` to point at a
  local dev server.
- **The fold.** The fold's terminal can run the same command, and any page or
  script can import `createInvite` (browser or Node) to mint an invite and
  push the code into the shared registry.

For all surfaces to be one identity: sign in with the **same Matrix account**
everywhere (`heimdall login --user …` on the CLI, "Sign in with my own account"
on the site, claim the account to fix a password). Keep the controller site
open on that account so live code confirmation works when a worker accepts.

## Deploy

It's a static Vite app. The included GitHub Actions workflow builds it and
publishes to GitHub Pages on every push to `main`.

```bash
git init && git add -A && git commit -m "heimdall"
# create a repo on GitHub, then:
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Then: repo **Settings → Pages → Source: GitHub Actions**. Done — the share
links will be `https://<you>.github.io/<repo>/?room=...&hs=...`.

Local dev:

```bash
npm install
npm run dev
```

## How it stays up

- The worker keeps the screen awake (Wake Lock) and pings the controller every
  15s over the DataChannel.
- The controller re-negotiates any peer that drops, and periodically scans the
  room for new member devices.
- If a device's tab is suspended (iOS especially), it reconnects automatically
  when reopened. Install to home screen / add to desktop for the most reliable
  uptime.

## Limits (by design, for now)

- WebRTC is **star topology**: controller ↔ each worker. No worker-to-worker mesh yet.
- **STUN only**, no TURN server: peers behind a strict symmetric NAT may not connect.
- WebLLM wants **WebGPU**. Without it the worker shows a warning and inference
  will be slow or unavailable.
- One model per worker (selectable before accepting).

## Next steps

- TURN (coturn) for NAT traversal, fleet scaling.
- Mesh routing between workers (today borrows route through the host), job queue with model/worker affinity.
- The fold — this page is already its door; the same accept-link can later
  bind a fold instance to a fleet room.