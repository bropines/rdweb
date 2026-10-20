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
            value: { union: { case: "opened", value: { terminalId: 0, success: !opts.refuse, message: opts.refuse ?? "", pid: 42 } } },
          },
        });
        if (!opts.refuse) {
          const big = zstdCompressSync(Buffer.from("PS C:\\Users\\me> "));
          peer.send({ union: { case: "terminalResponse", value: { union: { case: "data", value: { terminalId: 0, data: new Uint8Array(big), compressed: true } } } } });
        }
      } else if (a.case === "data") {
        // echo
        peer.send({ union: { case: "terminalResponse", value: { union: { case: "data", value: { terminalId: 0, data: a.value.data } } } } });
      } else if (a.case === "close") {
        peer.send({ union: { case: "terminalResponse", value: { union: { case: "closed", value: { terminalId: 0, exitCode: 0 } } } } });
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
});
