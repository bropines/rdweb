// Server check: can a browser reach the ID server (hbbs) and the relay (hbbr)
// over WebSocket, does hbbs vouch for the configured key, is a device online.
//
// Read-only by design: nothing sent here makes hbbs contact a device (no
// PunchHoleRequest, no RequestRelay). The relay WebSocket is opened and closed
// again without a message; the only request is an OnlineRequest, which hbbs
// answers from its own registration table.
//
// About the key: hbbs sends an unsolicited KeyExchange (its per-process
// X25519 key signed with the server's Ed25519 key) as the first frame of a TCP
// connection when it has a key, and RustDesk clients verify it with the
// configured key. hbbs does not send it on WebSocket connections, so against
// current hbbs the key step is skipped; it reports a mismatch when a server
// does send one.

import nacl from "tweetnacl";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { parseServerKey } from "./crypto.js";
import { relayUrlNextTo } from "./connector.js";
import { RendezvousMessageSchema, type KeyExchange, type RendezvousMessage } from "./proto/rendezvous_pb.js";
import { TransportError, WsTransport } from "./transport.js";
import type { ServerConfig } from "./types.js";

export type ServerCheckStepId = "rendezvous" | "key" | "relay" | "device";
export type ServerCheckStatus = "ok" | "fail" | "skip";
/**
 * unreachable: the WebSocket could not be opened (DNS, TLS certificate,
 * proxy, port); timeout: no answer in time; key-mismatch: hbbs signed its key
 * with a different server key; bad-config: the URL or key is malformed;
 * offline: hbbs does not list the device as online.
 */
export type ServerCheckCode = "unreachable" | "timeout" | "key-mismatch" | "bad-config" | "offline";

export interface ServerCheckStep {
  id: ServerCheckStepId;
  status: ServerCheckStatus;
  /** Duration of the step (connect time, or the round trip). */
  ms?: number;
  /** What happened, in English, for logs and tooltips. */
  detail?: string;
  code?: ServerCheckCode;
}

export interface ServerCheck {
  /** No step failed. */
  ok: boolean;
  /** rendezvous, key, relay and (with `peerId`) device, in this order. */
  steps: ServerCheckStep[];
  /** The endpoints that were checked. */
  rendezvousUrl: string;
  relayUrl: string;
}

export interface ServerCheckOptions {
  /** Also ask hbbs whether this device is online (an OnlineRequest; the device is not contacted). */
  peerId?: string;
  /** Per connection and per answer (default 8000 ms). */
  timeoutMs?: number;
  /** How long to wait for hbbs' unsolicited KeyExchange (default 1000 ms). */
  keyWaitMs?: number;
  signal?: AbortSignal;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const elapsed = (t0: number) => Math.max(0, Math.round(now() - t0));

/**
 * Checks a server the way a connection would use it, without contacting any
 * device. Resolves with every step's outcome; rejects only when `signal`
 * aborts.
 */
export async function checkServer(server: ServerConfig, opts: ServerCheckOptions = {}): Promise<ServerCheck> {
  const { signal } = opts;
  if (signal?.aborted) throw abortReason(signal);
  const timeoutMs = opts.timeoutMs ?? 8000;
  const keyWaitMs = Math.min(opts.keyWaitMs ?? 1000, timeoutMs);
  const peerId = (opts.peerId ?? "").replace(/\s+/g, "");
  const rendezvousUrl = (server.rendezvousUrl ?? "").trim();

  let relayUrl = "";
  let relayProblem: string | null = null;
  try {
    relayUrl = server.relayUrl ? server.relayUrl("") : relayUrlNextTo(rendezvousUrl);
  } catch (e) {
    relayProblem = `cannot derive the relay URL: ${(e as Error).message}`;
  }
  relayProblem ??= wsUrlProblem(relayUrl);

  try {
    const [hbbs, relay] = await Promise.all([
      checkHbbs(rendezvousUrl, server.key ?? "", peerId, timeoutMs, keyWaitMs, signal),
      checkRelay(relayUrl, relayProblem, timeoutMs, signal),
    ]);
    const steps = [hbbs.rendezvous, hbbs.key, relay];
    if (peerId) steps.push(hbbs.device);
    return { ok: steps.every((s) => s.status !== "fail"), steps, rendezvousUrl, relayUrl };
  } catch (e) {
    if (signal?.aborted) throw abortReason(signal);
    throw e;
  }
}

interface HbbsSteps {
  rendezvous: ServerCheckStep;
  key: ServerCheckStep;
  device: ServerCheckStep;
}

async function checkHbbs(
  url: string,
  key: string,
  peerId: string,
  timeoutMs: number,
  keyWaitMs: number,
  signal: AbortSignal | undefined,
): Promise<HbbsSteps> {
  let serverKey: Uint8Array | null = null;
  let keyStep: ServerCheckStep | null = null;
  try {
    serverKey = parseServerKey(key);
  } catch (e) {
    keyStep = { id: "key", status: "fail", code: "bad-config", detail: (e as Error).message };
  }
  const notReached = (id: ServerCheckStepId): ServerCheckStep => ({ id, status: "skip", detail: "the ID server was not reached" });

  const problem = wsUrlProblem(url);
  if (problem) {
    return {
      rendezvous: { id: "rendezvous", status: "fail", code: "bad-config", detail: problem },
      key: keyStep ?? notReached("key"),
      device: notReached("device"),
    };
  }

  const t0 = now();
  let t: WsTransport;
  try {
    t = await WsTransport.open(url, { timeoutMs, signal });
  } catch (e) {
    return {
      rendezvous: { id: "rendezvous", status: "fail", ms: elapsed(t0), ...transportFailure(e, signal) },
      key: keyStep ?? notReached("key"),
      device: notReached("device"),
    };
  }
  const rendezvous: ServerCheckStep = { id: "rendezvous", status: "ok", ms: elapsed(t0) };

  try {
    // hbbs would send its KeyExchange right after the connection opened.
    if (!keyStep) {
      const t1 = now();
      const kx = await firstKeyExchange(t, keyWaitMs, signal);
      keyStep = verifyKeyExchange(kx, serverKey!, keyWaitMs, elapsed(t1));
    }

    let device: ServerCheckStep = { id: "device", status: "skip" };
    if (peerId) device = await queryOnline(t, peerId, timeoutMs, signal);
    return { rendezvous, key: keyStep, device };
  } finally {
    t.close("check done");
  }
}

function verifyKeyExchange(kx: KeyExchange | null, serverKey: Uint8Array, waitedMs: number, ms: number): ServerCheckStep {
  if (!kx) {
    return {
      id: "key",
      status: "skip",
      detail: `the ID server sent no signed key within ${waitedMs} ms (hbbs sends it on TCP connections only, not over WebSocket)`,
    };
  }
  const signed = kx.keys[0];
  if (!signed?.length) return { id: "key", status: "skip", detail: "the ID server sent a key exchange without a key" };
  if (!nacl.sign.open(signed, serverKey)) {
    return { id: "key", status: "fail", ms, code: "key-mismatch", detail: "the ID server's signed key does not verify with the configured public key" };
  }
  return { id: "key", status: "ok", ms, detail: "the ID server's signed key verifies with the configured public key" };
}

/** The KeyExchange hbbs sends unsolicited on connect, or null if none arrives in `waitMs`. */
async function firstKeyExchange(t: WsTransport, waitMs: number, signal: AbortSignal | undefined): Promise<KeyExchange | null> {
  const deadline = now() + waitMs;
  for (;;) {
    const left = deadline - now();
    if (left <= 0) return null;
    let msg: RendezvousMessage | null;
    try {
      msg = decode(await t.next(left, signal));
    } catch (e) {
      if (e instanceof TransportError && e.code === "aborted") throw e;
      return null; // timeout, or the server closed the connection
    }
    if (msg?.union.case === "keyExchange") return msg.union.value;
  }
}

async function queryOnline(t: WsTransport, peerId: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<ServerCheckStep> {
  const t0 = now();
  try {
    t.send(toBinary(RendezvousMessageSchema, create(RendezvousMessageSchema, { union: { case: "onlineRequest", value: { peers: [peerId] } } })));
    const deadline = t0 + timeoutMs;
    for (;;) {
      const left = deadline - now();
      if (left <= 0) throw new TransportError("timed out waiting for the server", "timeout");
      const msg = decode(await t.next(left, signal));
      if (msg?.union.case !== "onlineResponse") continue;
      const online = ((msg.union.value.states[0] ?? 0) & 0x80) !== 0;
      return online
        ? { id: "device", status: "ok", ms: elapsed(t0), detail: `${peerId} is online` }
        : { id: "device", status: "fail", ms: elapsed(t0), code: "offline", detail: `${peerId} is offline or not registered on this server` };
    }
  } catch (e) {
    return { id: "device", status: "fail", ms: elapsed(t0), ...transportFailure(e, signal) };
  }
}

async function checkRelay(url: string, problem: string | null, timeoutMs: number, signal: AbortSignal | undefined): Promise<ServerCheckStep> {
  if (problem) return { id: "relay", status: "fail", code: "bad-config", detail: problem };
  const t0 = now();
  try {
    const t = await WsTransport.open(url, { timeoutMs, signal });
    const ms = elapsed(t0);
    t.close("check done"); // nothing sent: hbbr waits for a RequestRelay and drops the socket
    return { id: "relay", status: "ok", ms };
  } catch (e) {
    return { id: "relay", status: "fail", ms: elapsed(t0), ...transportFailure(e, signal) };
  }
}

function decode(raw: Uint8Array): RendezvousMessage | null {
  if (raw.length === 0) return null; // keep-alive
  try {
    return fromBinary(RendezvousMessageSchema, raw);
  } catch {
    return null;
  }
}

function transportFailure(e: unknown, signal: AbortSignal | undefined): Pick<ServerCheckStep, "code" | "detail"> {
  if (e instanceof TransportError) {
    if (e.code === "aborted" || signal?.aborted) throw e;
    return { code: e.code === "timeout" ? "timeout" : "unreachable", detail: e.message };
  }
  return { code: "unreachable", detail: e instanceof Error ? e.message : String(e) };
}

/** Why a browser cannot open `url` as a WebSocket, or null. */
function wsUrlProblem(url: string): string | null {
  if (!url) return "no URL";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `not a valid URL: ${url}`;
  }
  if (u.protocol !== "ws:" && u.protocol !== "wss:") return `not a WebSocket URL (ws:// or wss://): ${url}`;
  if (!u.hostname) return `no host in ${url}`;
  if (u.protocol === "ws:" && typeof location !== "undefined" && location.protocol === "https:") {
    return "a page served over HTTPS cannot open ws:// URLs; use wss://";
  }
  return null;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new TransportError("aborted", "aborted");
}
