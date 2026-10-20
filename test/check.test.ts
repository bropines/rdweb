// checkServer against the in-memory hbbs/hbbr: reachability, the signed key,
// presence, and that nothing is sent that would make hbbs contact a device.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nacl from "tweetnacl";
import { checkServer, type ServerCheck } from "../src/check.js";
import { encodeBase64 } from "../src/crypto.js";
import { FakeSocket, PEER_ID, net, resetNet, serverConfig, type PeerConfig } from "./peer.js";

const OPTS = { keyWaitMs: 30, timeoutMs: 1000 };

const byId = (r: ServerCheck) => Object.fromEntries(r.steps.map((s) => [s.id, s]));
const statuses = (r: ServerCheck) => r.steps.map((s) => `${s.id}:${s.status}${s.code ? `:${s.code}` : ""}`);

function setup(config: PeerConfig = {}) {
  resetNet(config);
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  // read-only: never a punch hole or relay request, so no device is contacted
  expect(net.punchRequests).toEqual([]);
  expect(net.relayRequests).toEqual([]);
});

describe("checkServer", () => {
  it("passes with a reachable ID server and relay and a key signed by the configured key", async () => {
    setup({ keyExchange: "valid" });
    const r = await checkServer(serverConfig(), OPTS);
    expect(statuses(r)).toEqual(["rendezvous:ok", "key:ok", "relay:ok"]);
    expect(r.ok).toBe(true);
    expect(r.rendezvousUrl).toBe("wss://srv.example/ws/id");
    expect(r.relayUrl).toBe("wss://srv.example/ws/relay");
    for (const s of r.steps) expect(typeof s.ms).toBe("number");
    expect(net.opened.sort()).toEqual(["wss://srv.example/ws/id", "wss://srv.example/ws/relay"]);
    expect(net.onlineRequests).toEqual([]);
  });

  it("reports key-mismatch when hbbs signed its key with another server key", async () => {
    setup({ keyExchange: "wrong-key" });
    const r = await checkServer(serverConfig(), OPTS);
    expect(statuses(r)).toEqual(["rendezvous:ok", "key:fail:key-mismatch", "relay:ok"]);
    expect(r.ok).toBe(false);
  });

  it("reports key-mismatch when the configured key is not the server's", async () => {
    setup({ keyExchange: "valid" });
    const r = await checkServer({ ...serverConfig(), key: encodeBase64(nacl.sign.keyPair().publicKey) }, OPTS);
    expect(byId(r).key).toMatchObject({ status: "fail", code: "key-mismatch" });
  });

  it("skips the key when hbbs sends no KeyExchange (WebSocket connections)", async () => {
    setup();
    const r = await checkServer(serverConfig(), OPTS);
    expect(statuses(r)).toEqual(["rendezvous:ok", "key:skip", "relay:ok"]);
    expect(byId(r).key!.detail).toMatch(/WebSocket/);
    expect(r.ok).toBe(true);
  });

  it("reports an unreachable relay", async () => {
    setup({ keyExchange: "valid", unreachable: ["/ws/relay"] });
    const r = await checkServer(serverConfig(), OPTS);
    expect(statuses(r)).toEqual(["rendezvous:ok", "key:ok", "relay:fail:unreachable"]);
    expect(r.ok).toBe(false);
  });

  it("reports an unreachable ID server and skips what depends on it", async () => {
    setup({ unreachable: ["/ws/id"] });
    const r = await checkServer(serverConfig(), { ...OPTS, peerId: PEER_ID });
    expect(statuses(r)).toEqual(["rendezvous:fail:unreachable", "key:skip", "relay:ok", "device:skip"]);
  });

  it("reports a timeout when the WebSocket never opens", async () => {
    setup({ stalled: ["/ws/relay"] });
    const r = await checkServer(serverConfig(), { ...OPTS, timeoutMs: 50 });
    expect(byId(r).relay).toMatchObject({ status: "fail", code: "timeout" });
  });

  it("reports a device as online with an OnlineRequest only", async () => {
    setup({ online: [PEER_ID] });
    const r = await checkServer(serverConfig(), { ...OPTS, peerId: "123 456 789" });
    expect(statuses(r)).toEqual(["rendezvous:ok", "key:skip", "relay:ok", "device:ok"]);
    expect(net.onlineRequests.map((q) => q.peers)).toEqual([[PEER_ID]]);
  });

  it("reports a device as offline", async () => {
    setup({ keyExchange: "valid", online: [PEER_ID] });
    const r = await checkServer(serverConfig(), { ...OPTS, peerId: "999000111" });
    expect(statuses(r)).toEqual(["rendezvous:ok", "key:ok", "relay:ok", "device:fail:offline"]);
    expect(net.onlineRequests.map((q) => q.peers)).toEqual([["999000111"]]);
    expect(r.ok).toBe(false);
  });

  it("flags malformed URLs and keys as bad-config without connecting", async () => {
    setup();
    const r = await checkServer({ rendezvousUrl: "https://srv.example/ws/id", relayUrl: () => "not a url", key: "abc" }, OPTS);
    expect(statuses(r)).toEqual(["rendezvous:fail:bad-config", "key:fail:bad-config", "relay:fail:bad-config"]);
    expect(net.opened).toEqual([]);
  });

  it("derives the relay next to the ID server when no relayUrl is given", async () => {
    setup();
    const r = await checkServer({ rendezvousUrl: "wss://srv.example/ws/id", key: serverConfig().key }, OPTS);
    expect(r.relayUrl).toBe("wss://srv.example/ws/relay");
    expect(byId(r).relay!.status).toBe("ok");
  });

  it("rejects when aborted", async () => {
    setup({ stalled: ["/ws/id", "/ws/relay"] });
    const ac = new AbortController();
    const p = checkServer(serverConfig(), { ...OPTS, signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toBeDefined();
  });
});
