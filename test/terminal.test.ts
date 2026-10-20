// TerminalSession against the in-memory server/peer: login as a terminal
// connection, open, keystrokes, (compressed) output, resize, exit, refusal.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zstdCompressSync } from "node:zlib";
import { ConnType } from "../src/proto/rendezvous_pb.js";
import type { Message } from "../src/proto/session_pb.js";
import { TerminalSession } from "../src/terminal.js";
import { FakeSocket, PASSWORD, PEER_ID, net, resetNet, serverConfig, sha256, SALT, type FakePeer } from "./peer.js";

const terminalActions = () =>
  net.log.flatMap((m: Message) => (m.union.case === "terminalAction" ? [m.union.value.union] : []));

function peerShell(opts: { refuse?: string } = {}) {
  resetNet({
    onMessage: (m: Message, peer: FakePeer) => {
      if (m.union.case !== "terminalAction") return;
      const a = m.union.value.union;
      if (a.case === "open") {
        peer.send({
          union: {
            case: "terminalResponse",
            value: { union: { case: "opened", value: { terminalId: a.value.terminalId, success: !opts.refuse, message: opts.refuse ?? "", pid: 42 } } },
          },
        });
        if (!opts.refuse && a.value.terminalId === 0) {
          const big = zstdCompressSync(Buffer.from("PS C:\\Users\\me> "));
          peer.send({ union: { case: "terminalResponse", value: { union: { case: "data", value: { terminalId: 0, data: new Uint8Array(big), compressed: true } } } } });
        }
      } else if (a.case === "data") {
        // echo
        peer.send({ union: { case: "terminalResponse", value: { union: { case: "data", value: { terminalId: a.value.terminalId, data: a.value.data } } } } });
      } else if (a.case === "close") {
        peer.send({ union: { case: "terminalResponse", value: { union: { case: "closed", value: { terminalId: a.value.terminalId, exitCode: 0 } } } } });
      }
    },
  });
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TerminalSession", () => {
  it("opens a shell over a terminal connection", async () => {
    peerShell();
    const s = new TerminalSession({ peerId: PEER_ID, server: serverConfig(), rememberedHash: sha256(PASSWORD, SALT), cols: 100, rows: 30 });
    const out: string[] = [];
    s.on("data", ({ data }) => out.push(new TextDecoder().decode(data)));
    await s.connect();

    expect(net.punchRequests.at(-1)?.connType ?? net.relayRequests.at(-1)?.connType).toBe(ConnType.TERMINAL);
    expect(net.loginRequests.at(-1)?.union.case).toBe("terminal");
    const open = terminalActions()[0];
    expect(open).toMatchObject({ case: "open", value: { terminalId: 0, cols: 100, rows: 30 } });

    s.write("dir\r");
    s.resize(120, 40);
    s.resize(120, 40); // unchanged: not sent again
    await vi.waitFor(() => expect(out.join("")).toBe("PS C:\\Users\\me> dir\r"));
    const kinds = terminalActions().map((a) => a.case);
    expect(kinds).toEqual(["open", "data", "resize"]);
    s.close();
    expect(terminalActions().at(-1)?.case).toBe("close");
    expect(s.state).toBe("closed");
  });

  it("reports a peer that refuses the terminal", async () => {
    peerShell({ refuse: "Terminal is disabled" });
    const s = new TerminalSession({ peerId: PEER_ID, server: serverConfig(), rememberedHash: sha256(PASSWORD, SALT) });
    await expect(s.connect()).rejects.toMatchObject({ code: "refused", message: "Terminal is disabled" });
    expect(s.state).toBe("closed");
  });

  it("ends when the shell exits", async () => {
    peerShell();
    const s = new TerminalSession({ peerId: PEER_ID, server: serverConfig(), rememberedHash: sha256(PASSWORD, SALT) });
    const exits: number[] = [];
    s.on("exit", ({ code }) => exits.push(code));
    await s.connect();
    net.peer!.send({ union: { case: "terminalResponse", value: { union: { case: "closed", value: { terminalId: 0, exitCode: 3 } } } } });
    await vi.waitFor(() => expect(s.state).toBe("closed"));
    expect(exits).toEqual([3]);
  });

  it("opens more shells (tabs) on the same connection", async () => {
    peerShell();
    const s = new TerminalSession({ peerId: PEER_ID, server: serverConfig(), rememberedHash: sha256(PASSWORD, SALT) });
    const out = new Map<number, string>();
    s.on("data", ({ terminalId, data }) => out.set(terminalId, (out.get(terminalId) ?? "") + new TextDecoder().decode(data)));
    await s.connect();
    await s.openTerminal(1, 90, 20);
    expect(s.terminals).toEqual([0, 1]);
    expect(terminalActions().at(-1)).toMatchObject({ case: "open", value: { terminalId: 1, cols: 90, rows: 20 } });
    s.write("one", 1);
    s.write("zero");
    await vi.waitFor(() => expect(out.get(1)).toBe("one"));
    expect(out.get(0)).toContain("zero");
    await expect(s.openTerminal(1, 80, 24)).rejects.toMatchObject({ code: "state" });

    // closing a tab keeps the session; closing the last one ends it
    s.closeTerminal(1);
    await vi.waitFor(() => expect(s.terminals).toEqual([0]));
    expect(s.state).toBe("connected");
    s.closeTerminal(0);
    await vi.waitFor(() => expect(s.state).toBe("closed"));
  });

  it("asks to keep the shells and reattaches with the service id", async () => {
    resetNet({
      onMessage: (m: Message, peer: FakePeer) => {
        if (m.union.case !== "terminalAction" || m.union.value.union.case !== "open") return;
        const id = m.union.value.union.value.terminalId;
        peer.send({
          union: {
            case: "terminalResponse",
            value: {
              union: {
                case: "opened",
                value: { terminalId: id, success: true, serviceId: "svc-1", persistentSessions: id === 0 ? [3, 2] : [], replayTerminalOutput: true },
              },
            },
          },
        });
        peer.send({ union: { case: "terminalResponse", value: { union: { case: "data", value: { terminalId: id, data: new TextEncoder().encode("old") } } } } });
        peer.send({ union: { case: "terminalResponse", value: { union: { case: "data", value: { terminalId: id, data: new TextEncoder().encode("new") } } } } });
      },
    });
    const s = new TerminalSession({ peerId: PEER_ID, server: serverConfig(), rememberedHash: sha256(PASSWORD, SALT), persistent: true, serviceId: "svc-1" });
    const seen: string[] = [];
    s.on("data", ({ terminalId, data, replay }) => seen.push(`${terminalId}:${new TextDecoder().decode(data)}:${replay}`));
    await s.connect();
    const login = net.loginRequests.at(-1)!;
    expect(login.option?.terminalPersistent).toBe(2); // Yes
    expect(login.union).toMatchObject({ case: "terminal", value: { serviceId: "svc-1" } });
    expect(s.serviceId).toBe("svc-1");
    expect(s.restorable).toEqual([2, 3]);
    await s.openTerminal(2, 80, 24);
    await vi.waitFor(() => expect(seen).toEqual(["0:old:true", "0:new:false", "2:old:true", "2:new:false"]));
    // a reconnect keeps the shells; only Back (close without keepShells) ends them
    s.close("reconnect", { keepShells: true });
    expect(terminalActions().filter((a) => a.case === "close")).toEqual([]);

    // "Close" on a remembered service ends every shell, open or not
    const s2 = new TerminalSession({ peerId: PEER_ID, server: serverConfig(), rememberedHash: sha256(PASSWORD, SALT), persistent: true, serviceId: "svc-1" });
    await s2.connect();
    s2.closeService();
    const closed = terminalActions()
      .filter((a) => a.case === "close")
      .map((a) => (a.value as { terminalId: number }).terminalId)
      .sort();
    expect(closed).toEqual([0, 2, 3]);
    expect(s2.state).toBe("closed");
  });
});
