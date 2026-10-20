// End-to-end smoke test against a real server and peer, from Node (no
// WebCodecs: frames are counted, not decoded).
//
//   RDWEB_ID_URL=wss://host/ws/id RDWEB_RELAY_URL=wss://host/ws/relay \
//   RDWEB_KEY=<server public key> RDWEB_PEER=<id> RDWEB_PASSWORD=<pwd> \
//   node test/e2e-node.mjs
import { Session } from "../dist/index.js";
globalThis.RDWEB_DEBUG = process.env.RDWEB_DEBUG === "1";

const env = (k, d) => process.env[k] ?? d;
const seconds = Number(env("RDWEB_SECONDS", "8"));
const session = new Session({
  peerId: env("RDWEB_PEER"),
  server: {
    rendezvousUrl: env("RDWEB_ID_URL"),
    relayUrl: env("RDWEB_RELAY_URL") ? () => env("RDWEB_RELAY_URL") : undefined,
    key: env("RDWEB_KEY"),
  },
  myName: "rdweb e2e",
  settings: { imageQuality: env("RDWEB_QUALITY", "balanced"), codec: env("RDWEB_CODEC", "auto") },
});
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(2)}s]`, ...a);
session.on("state", ({ state }) => log("state", state));
session.on("password", ({ wrong }) => {
  log("password requested", wrong ? "(wrong)" : "");
  if (wrong) {
    session.close("wrong password");
    return;
  }
  const pwd = env("RDWEB_PASSWORD");
  if (pwd) void session.login(pwd);
});
session.on("waitingForApproval", () => log("waiting for approval"));
session.on("twoFactor", () => log("2FA required"));
session.on("connected", ({ peer }) =>
  log("connected", JSON.stringify({ ...peer, displays: peer.displays.map((d) => `${d.index}:${d.x},${d.y} ${d.width}x${d.height} ${d.name}`) })),
);
session.on("display", ({ display, resolutions }) => log("display", JSON.stringify(display), "resolutions", resolutions.length));
session.on("cursorShape", ({ id }) => {
  const c = session.cursor;
  log("cursor", id, c && `${c.width}x${c.height} hot ${c.hotX},${c.hotY} empty=${c.empty}`);
});
session.on("cursorPosition", ({ x, y }) => log("cursor pos", x, y));
session.on("permission", (p) => log("permission", p.name, p.enabled));
session.on("message", (m) => log("message", JSON.stringify(m)));
session.on("stats", (s) => log("stats", JSON.stringify(s)));
session.on("close", (c) => log("close", JSON.stringify(c)));
try {
  await session.connect();
  const d = session.display;
  if (d && env("RDWEB_MOVE", "1") === "1") {
    session.mouseMove(d.x + d.width / 2, d.y + d.height / 2);
  }
  await new Promise((r) => setTimeout(r, seconds * 1000));
  session.close("e2e done");
} catch (e) {
  log("connect failed:", e.code, e.message);
  process.exitCode = 1;
}
