// "Request approval" (RustDesk 1.5.3): the login carries no password from any
// source and the connection waits for the remote user. Driven against the
// in-memory server/peer through the three session kinds that share the connector.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileTransferSession } from "../src/files/session.js";
import { Session } from "../src/session.js";
import { FakeFs } from "./fakefs.js";
import { TerminalSession } from "../src/terminal.js";
import { FakeSocket, PASSWORD, PEER_ID, net, resetNet, serverConfig, sha256, SALT, type PeerConfig } from "./peer.js";

const hash = () => sha256(PASSWORD, SALT);
const sentPasswords = () => net.loginRequests.map((l) => l.password.length);
const closeReasons = () =>
  net.log.flatMap((m) => (m.union.case === "misc" && m.union.value.union.case === "closeReason" ? [m.union.value.union.value] : []));

function peer(config: PeerConfig = {}) {
  resetNet({
    onMessage: (m, p) => {
      // enough of a shell for TerminalSession.connect() to resolve
      if (m.union.case === "terminalAction" && m.union.value.union.case === "open") {
        p.send({
          union: {
            case: "terminalResponse",
            value: { union: { case: "opened", value: { terminalId: m.union.value.union.value.terminalId, success: true, message: "", pid: 1 } } },
          },
        });
      }
    },
    ...config,
  });
}

const terminal = (extra: Partial<ConstructorParameters<typeof TerminalSession>[0]> = {}) =>
  new TerminalSession({ peerId: PEER_ID, server: serverConfig(), ...extra });

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("login request construction", () => {
  it("default: the remembered hash is proven, unchanged", async () => {
    peer();
    const s = terminal({ rememberedHash: hash() });
    await s.connect();
    expect(sentPasswords()).toEqual([32]);
    s.close();
  });

  it("default: with nothing remembered an empty login goes out and the password is asked for", async () => {
    peer();
    const s = terminal();
    const asked = vi.fn();
    s.on("password", asked);
    const waiting = vi.fn();
    s.on("waitingForApproval", waiting);
    const p = s.connect();
    await vi.waitFor(() => expect(asked).toHaveBeenCalledWith({ wrong: false }));
    expect(sentPasswords()).toEqual([0]);
    await s.login(PASSWORD);
    await p;
    expect(sentPasswords()).toEqual([0, 32]);
    expect(waiting).not.toHaveBeenCalled();
    s.close();
  });

  it("request approval: an empty password even with a remembered hash, and no password prompt", async () => {
    peer({ onEmptyLogin: (d) => d.accept() });
    const s = terminal({ rememberedHash: hash(), requestApproval: true });
    const asked = vi.fn();
    s.on("password", asked);
    const waiting = vi.fn();
    s.on("waitingForApproval", waiting);
    await s.connect();
    expect(sentPasswords()).toEqual([0]);
    expect(asked).not.toHaveBeenCalled();
    expect(waiting).toHaveBeenCalledTimes(1);
    s.close();
  });

  it("request approval: a password supplied by the caller is ignored", async () => {
    let decide: (() => void) | undefined;
    peer({ onEmptyLogin: (d) => (decide = d.accept) });
    const s = terminal({ rememberedHash: hash(), requestApproval: true });
    const remembered = vi.fn();
    s.on("connected", (e) => remembered(e.rememberedHash));
    const p = s.connect();
    await vi.waitFor(() => expect(decide).toBeTypeOf("function"));
    await s.login(PASSWORD);
    await s.login(PASSWORD);
    expect(sentPasswords()).toEqual([0]);
    decide!();
    await p;
    expect(sentPasswords()).toEqual([0]);
    // nothing was proven, so there is nothing to remember
    expect(remembered).toHaveBeenCalledWith(null);
    s.close();
  });

  it("request approval: the connection logs in once the remote user accepts, with no hash to remember", async () => {
    peer({ onEmptyLogin: (d) => setTimeout(d.accept, 5) });
    const s = terminal({ requestApproval: true });
    const connected = new Promise<Uint8Array | null>((resolve) => s.on("connected", (e) => resolve(e.rememberedHash)));
    await s.connect();
    expect(await connected).toBeNull();
    expect(sentPasswords()).toEqual([0]);
    s.close();
  });

  it("request approval on a desktop session and a file transfer: no password either", async () => {
    const fs = new FakeFs({});
    peer({
      onEmptyLogin: (d) => d.accept(),
      // a file transfer is up once the first listing arrives
      afterLogin: (p) => fs.handle({ union: { case: "fileAction", value: { union: { case: "readDir", value: { path: "", includeHidden: false } } } } } as never, p),
      onMessage: (m, p) => fs.handle(m, p),
    });
    const d = new Session({ peerId: PEER_ID, server: serverConfig(), rememberedHash: hash(), requestApproval: true });
    await d.connect();
    d.close();
    const f = new FileTransferSession({ peerId: PEER_ID, server: serverConfig(), rememberedHash: hash(), requestApproval: true });
    await f.connect();
    f.close();
    expect(sentPasswords()).toEqual([0, 0]);
  });

  it("requestApproval: false is the default behaviour", async () => {
    peer();
    const s = terminal({ rememberedHash: hash(), requestApproval: false });
    await s.connect();
    expect(sentPasswords()).toEqual([32]);
    s.close();
  });
});

describe("waiting for the remote user", () => {
  it("a device that only allows passwords refuses: approval-unavailable, no password sent", async () => {
    peer({ onEmptyLogin: (d) => d.send({ union: { case: "loginResponse", value: { union: { case: "error", value: "Empty Password" } } } }) });
    const s = terminal({ rememberedHash: hash(), requestApproval: true });
    const asked = vi.fn();
    s.on("password", asked);
    await expect(s.connect()).rejects.toMatchObject({ code: "approval-unavailable" });
    expect(asked).not.toHaveBeenCalled();
    expect(sentPasswords()).toEqual([0]);
    expect(s.state).toBe("closed");
  });

  it("the remote user declines: the close reason ends the wait", async () => {
    peer({ onEmptyLogin: (d) => d.send({ union: { case: "misc", value: { union: { case: "closeReason", value: "Connection declined" } } } }) });
    const s = terminal({ requestApproval: true });
    await expect(s.connect()).rejects.toMatchObject({ code: "remote-closed", message: "Connection declined" });
    expect(s.state).toBe("closed");
  });

  it("the link drops while waiting: approval-ended, not retryable (a retry would ask again)", async () => {
    peer({ onEmptyLogin: (d) => d.drop() });
    const s = terminal({ requestApproval: true });
    const closed = vi.fn();
    s.on("close", closed);
    await expect(s.connect()).rejects.toMatchObject({ code: "approval-ended" });
    expect(closed).toHaveBeenCalledWith(expect.objectContaining({ retryable: false }));
  });

  it("nobody answers: approval-timeout after approvalTimeoutMs, and the device is told", async () => {
    peer();
    const s = terminal({ requestApproval: true, approvalTimeoutMs: 40 });
    await expect(s.connect()).rejects.toMatchObject({ code: "approval-timeout" });
    expect(sentPasswords()).toEqual([0]);
    expect(closeReasons()).toEqual(["timeout"]);
  });

  it("acceptance before the timeout cancels it", async () => {
    peer({ onEmptyLogin: (d) => setTimeout(d.accept, 10) });
    const s = terminal({ requestApproval: true, approvalTimeoutMs: 60 });
    await s.connect();
    await new Promise((r) => setTimeout(r, 100));
    expect(s.state).not.toBe("closed");
    expect(closeReasons()).toEqual([]);
    s.close();
  });

  it("without request approval a dropped login stays a retryable network error", async () => {
    peer({ onEmptyLogin: (d) => d.drop() });
    const s = terminal();
    const closed = vi.fn();
    s.on("close", closed);
    s.on("password", () => {});
    await expect(s.connect()).rejects.toMatchObject({ code: "network" });
    expect(closed).toHaveBeenCalledWith(expect.objectContaining({ retryable: true }));
  });
});
