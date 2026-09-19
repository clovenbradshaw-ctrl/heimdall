#!/usr/bin/env node
// heimdall — generate a fleet invite from any terminal.
//   heimdall invite [--name "Your Name"] [--room !id:hs] [--new]
//   heimdall login --user @me:hs --password …
//   heimdall reset
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { login, registerAuto, randomUsername } from "../src/matrix.js";
import { createInvite, randomPassword } from "../src/invite.js";

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
  const user = flag("--user", "");
  const pass = flag("--password", "");
  if (user && pass) return login({ baseUrl, username: user, password });
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
  const creds = await login({ baseUrl, username: user, password });
  const state = load();
  state.creds = creds;
  save(state);
  console.log("signed in as", creds.userId);
} else if (cmd === "invite") {
  const state = load();
  const creds = await credsFor();
  const roomId = flag("--room", has("--new") ? "" : state.roomId);
  const name = flag("--name", creds.userId);
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
} else {
  console.log("heimdall — distributed inference invites");
  console.log("");
  console.log("  heimdall invite  [--name \"Your Name\"] [--room !id:hs] [--new] [--hs URL]");
  console.log("                   [--user @me:hs --password …]");
  console.log("  heimdall login   --user @me:hs --password …");
  console.log("  heimdall reset");
  console.log("");
  console.log("env: HEIMDALL_SITE overrides the link base, e.g. for local dev.");
}