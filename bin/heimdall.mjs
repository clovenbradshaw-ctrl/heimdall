#!/usr/bin/env node
// heimdall — run the fleet on this computer, or mint an invite.
//   heimdall up      [--port 8790] [--no-open] [--no-passthrough] [--lend gemma2:2b|none]
//   heimdall invite [--name "Your Name"] [--room !id:hs] [--new]
//   heimdall login --user @me:hs --password …
//   heimdall reset
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn } from "node:child_process";
// The Matrix SDK is large and slow to load; only the commands that talk to
// Matrix pay for it (`up` never does — the page does its own Matrix).
const matrixLib = () => import("../src/matrix.js");
const inviteLib = () => import("../src/invite.js");

const SITE = process.env.HEIMDALL_SITE || "https://clovenbradshaw-ctrl.github.io/heimdall/";
const HS = "https://hyphae.social";
const STATE_DIR = join(homedir(), ".heimdall");
const STATE = join(STATE_DIR, "state.json");

const args = process.argv.slice(2);
const cmd = args[0] || "invite";
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const has = (name) => args.includes(name);

function load() {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return {};
  }
}
function save(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 2));
}

const baseUrl = flag("--hs", HS);

async function credsFor() {
  const { login, registerAuto, randomUsername } = await matrixLib();
  const { randomPassword } = await inviteLib();
  const user = flag("--user", "");
  const pass = flag("--password", "");
  if (user && pass) return login({ baseUrl, username: user, password: pass });
  const state = load();
  if (state.creds?.accessToken) return state.creds;
  const password = randomPassword();
  const creds = await registerAuto({ baseUrl, username: randomUsername("heimdall"), password });
  return { ...creds, password };
}

if (cmd === "login") {
  const user = flag("--user", "");
  const pass = flag("--password", "");
  if (!user || !pass) {
    console.error("usage: heimdall login --user @me:server --password …");
    process.exit(1);
  }
  const { login } = await matrixLib();
  const creds = await login({ baseUrl, username: user, password: pass });
  const state = load();
  state.creds = creds;
  save(state);
  console.log("signed in as", creds.userId);
} else if (cmd === "invite") {
  const state = load();
  const creds = await credsFor();
  const roomId = flag("--room", has("--new") ? "" : state.roomId);
  const name = flag("--name", creds.userId);
  const { createInvite } = await inviteLib();
  const { url, exp, roomId: rid } = await createInvite({ baseUrl, creds, roomId, displayName: name, site: SITE });
  save({ creds, roomId: rid });
  console.log("INVITE   " + url);
  console.log("ROOM     " + rid);
  console.log("HOST     " + creds.userId);
  console.log("EXPIRES  " + new Date(exp).toISOString());
  console.log("");
  console.log("the 6-digit pairing code lives on the WORKER's device (its key fingerprint) —");
  console.log("have them read it to you, then Record it in the controller site (or fold).");
  console.log("keep the controller site open and signed into " + creds.userId + " so codes can be confirmed.");
} else if (cmd === "reset") {
  save({});
  console.log("stored session cleared");
} else if (cmd === "up") {
  await up();
} else {
  console.log("heimdall — distributed inference invites");
  console.log("");
  console.log("  heimdall up      run the fleet on this computer: page + Ollama-compatible bridge");
  console.log("                   [--port 8790] [--no-open] [--no-passthrough] [--lend <ollama model>|none]");
  console.log("  heimdall invite  [--name \"Your Name\"] [--room !id:hs] [--new] [--hs URL]");
  console.log("                   [--user @me:hs --password …]");
  console.log("  heimdall login   --user @me:hs --password …");
  console.log("  heimdall reset");
  console.log("");
  console.log("env: HEIMDALL_SITE overrides the link base, e.g. for local dev.");
}
/* ------------------------------------------------------------------ up */

async function up() {
  const { createBridge } = await import("../src/bridge-server.mjs");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dist = join(root, "dist");
  if (!existsSync(join(dist, "index.html"))) {
    console.log("building the page (first run only)…");
    const r = spawnSync("npx", ["--yes", "vite", "build"], { cwd: root, stdio: "inherit" });
    if (r.status !== 0) {
      console.error("build failed — run `npm install && npm run build` in " + root);
      process.exit(1);
    }
  }
  const port = Number(flag("--port", process.env.HEIMDALL_PORT || 8790));
  const upstream = (process.env.OLLAMA_HOST ? (process.env.OLLAMA_HOST.startsWith("http") ? process.env.OLLAMA_HOST : "http://" + process.env.OLLAMA_HOST) : "http://127.0.0.1:11434").replace(/\/+$/, "");
  const passthrough = !has("--no-passthrough");

  // What this computer lends back to the phones: the caller's default model
  // if Ollama has it, else the first chat model installed. --lend none = don't.
  let installed = [];
  try {
    installed = ((await (await fetch(upstream + "/api/tags", { signal: AbortSignal.timeout(3000) })).json()).models ?? []).map((m) => m.name);
  } catch {}
  const lendFlag = flag("--lend", "");
  const preferred = [lendFlag, process.env.ER7_DEFAULT_MODEL, "gemma2:2b"].filter(Boolean);
  const lendModel = lendFlag === "none" ? null
    : preferred.find((m) => installed.includes(m)) ?? installed.find((m) => !/embed/i.test(m)) ?? null;

  const bridge = createBridge({
    port,
    dist,
    upstream,
    passthrough,
    lendModel,
    site: process.env.HEIMDALL_SITE || SITE,
    log: (line) => console.log(new Date().toISOString().slice(11, 19) + "  " + line),
  });
  try {
    await bridge.listen();
  } catch (e) {
    if (e.code === "EADDRINUSE") {
      console.error(`port ${port} is taken — is heimdall already up? (open http://localhost:${port}) or pass --port`);
      process.exit(1);
    }
    throw e;
  }
  const url = `http://localhost:${port}/`;
  console.log("");
  console.log("  heimdall is up        " + url);
  console.log("  Ollama upstream       " + upstream + (installed.length ? `  (${installed.length} models)` : "  (not answering — pass-through will fail)"));
  console.log("  lending to phones     " + (lendModel || "nothing (no Ollama model)"));
  console.log("");
  console.log("  1. the page opens — it makes the fleet and shows a QR code");
  console.log("  2. scan it with your phone, tap Accept, type the phone's code on the page");
  console.log("  3. point eoreader7 (or anything that speaks Ollama) at the fleet:");
  console.log(`       ER7_OLLAMA_HOSTS="local=${upstream},fleet=http://localhost:${port}"`);
  console.log("");
  console.log("  keep the page open — it is the fleet's controller. ctrl-c to stop.");
  console.log("");
  if (!has("--no-open")) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    try { spawn(opener, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref(); } catch {}
  }
  const stop = () => bridge.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
