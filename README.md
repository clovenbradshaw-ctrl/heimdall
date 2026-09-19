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
4. The worker's device shows its pairing code; they tell it to you, you
   record it, they press **Accept compute duties** (their device proves the
   pairing with its private key) and pick a model size.
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
- **A 6-digit pairing code backed by a keypair.** Every device holds an ECDSA
  keypair; the code is a short fingerprint of its **public key**. The worker
  gives the code to the host out of band, the host records it, and acceptance
  proves the pairing cryptographically — the worker signs the room + identity +
  code hash with its **private key**, and the host verifies all three links:
  recorded code ⟷ public-key fingerprint ⟷ valid signature. A stolen link or a
  leaked code alone cannot fake the pairing, and used codes are consumed. (The
  6-digit fingerprint is a human handoff; the P-256 signature is the
  unforgeable identity. Bump the code length to raise fingerprint strength.)
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
`createInvite`), and the pairing codes live in the controller account's
account data — so every surface signed into that account can record *and*
confirm codes. The worker's device holds its own keypair, so the pairing
proof travels with the worker, not the surface.

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

- WebRTC is **star topology**: controller ↔ each worker, plus controller ↔
  controller coord links. No worker-to-worker mesh yet.
- **STUN only**, no TURN server: peers behind a strict symmetric NAT may not connect.
- WebLLM wants **WebGPU**. Without it the worker shows a warning and inference
  will be slow or unavailable.
- One model per worker (selectable before accepting).

## One animal, many heimdalls

Several heimdalls may share one fleet room — the same account open on many
surfaces (site + CLI + fold), or allied accounts controlling together. They
coordinate as a superorganism, with no leader and no central queue:

- **Presence.** Every controller announces itself (`hello-controller`,
  heartbeated) and the fleet card shows the organism: how many heimdalls,
  which are allies, how many coord links are open.
- **Model-aware routing.** A job naming a model only lands on a giver loaded
  with that exact model — otherwise it fails loudly, never as a quiet
  wrong-model answer. Unpinned jobs take the shortest expected wait
  (in-flight × measured mean, unmeasured tried rather than starved).
- **Shared load.** Same-account siblings merge inflight/pace snapshots;
  every worker reports its own queue depth, so a giver busy with another
  heimdall's jobs steers the next one away — including across accounts,
  authenticated by the worker itself.
- **Migration.** A borrow no local giver can serve is offered to a sibling
  that advertises the model, over a controller-to-controller DataChannel,
  settled per hop so every link earns/owes symmetric. One hop max, replays
  refused, timeouts loud.
- **Ally mode.** A controller that didn't create the room can't link workers
  (they answer their creator's devices only) and stops trying — it lends
  its own device and accepts forwards.
- **Trust boundary: the account.** Same-user snapshots steer routing;
  strangers' serves lists only ever attract a forward they must actually
  serve. Credit ledgers stay pairwise (reciprocity needs no center).

Verify it: `node --test src/route.test.mjs src/swarm.test.mjs` (19 cases),
`node scripts/stress-route.mjs` (60 concurrent surfaces × models × two
heimdalls, migration, per-hop settlement), and
`node scripts/falsify-route.mjs` (8000 fuzzed picks against the router's
invariants plus adversarial envelopes, replays, and garbage input —
controls built to fail, per the project's own II.23), and
`node scripts/measure-routing.mjs` (the A/B that prices the work:
model-blind round-robin vs the new router on the same seeded bursts —
wrong-model 12–15 → 0 with all 30 served, free-job avg 8840 → 3667ms
(−59%), Qwen-only origin serving 10 Llama jobs via migration instead of
failing all ten).

## Next steps

- TURN (coturn) for NAT traversal, fleet scaling.
- Mesh routing between workers (today borrows route through the host), job queue with model/worker affinity.
- The fold — this page is already its door; the same accept-link can later
  bind a fold instance to a fleet room.