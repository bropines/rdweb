// Drives a Session against an in-memory hbbs/hbbr/peer built from the same
// wire schema, covering rendezvous, the authenticated key exchange, login and
// the first media messages.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nacl from "tweetnacl";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";
import { zstdCompressSync } from "node:zlib";
import { RendezvousMessageSchema } from "../src/proto/rendezvous_pb.js";
import { IdPkSchema, MessageSchema, type Message } from "../src/proto/session_pb.js";
import { Session } from "../src/session.js";
import { encodeBase64 } from "../src/crypto.js";

const PEER_ID = "123456789";
const PASSWORD = "s3cret";
const SALT = "salt-xyz";
const CHALLENGE = "challenge-abc";

const serverSign = nacl.sign.keyPair();
const peerSign = nacl.sign.keyPair();

interface PeerBehaviour {
  /** sign SignedId with a key the server never vouched for */
  impostor?: boolean;
  /** server vouches for a different id */
  wrongServerId?: boolean;
  /** server sends no signed key */
  noServerKey?: boolean;
  requirePassword?: boolean;
}

let behaviour: PeerBehaviour = {};
let peerLog: Message[] = [];
let lastRelay: FakeSocket | null = null;

function signedIdPk(id: string, pk: Uint8Array, sk: Uint8Array): Uint8Array {
  return nacl.sign(toBinary(IdPkSchema, create(IdPkSchema, { id, pk })), sk);
}

function sha256(...parts: (Uint8Array | string)[]): Uint8Array {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

class FakeSocket {
  static OPEN = 1;
  binaryType = "blob";
  readyState = 0;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: (() => void) | null = null;
  private key: Uint8Array | null = null;
  private sendSeq = 0n;
  private recvSeq = 0n;

  constructor(readonly url: string) {
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
    if (url.includes("relay")) lastRelay = this;
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code: 1000, reason: "", wasClean: true }));
  }

  private deliver(bytes: Uint8Array): void {
    const copy = bytes.slice().buffer;
    queueMicrotask(() => this.onmessage?.({ data: copy }));
  }

  private nonce(seq: bigint): Uint8Array {
    const n = new Uint8Array(24);
    new DataView(n.buffer).setBigUint64(0, seq, true);
    return n;
  }

  /** Peer -> client, encrypted once the key is set. */
  peerSend(init: Parameters<typeof create<typeof MessageSchema>>[1]): void {
    let bytes = toBinary(MessageSchema, create(MessageSchema, init));
    if (this.key) {
      this.sendSeq++;
      bytes = nacl.secretbox(bytes, this.nonce(this.sendSeq), this.key);
    }
    this.deliver(bytes);
  }

  send(data: Uint8Array): void {
    if (this.url.includes("/ws/id")) return this.onRendezvous(data);
    return this.onRelay(data);
  }

  private onRendezvous(data: Uint8Array): void {
    const msg = fromBinary(RendezvousMessageSchema, data);
    if (msg.union.case !== "punchHoleRequest") return;
    const id = behaviour.wrongServerId ? "999" : msg.union.value.id;
    const pk = behaviour.noServerKey ? new Uint8Array(0) : signedIdPk(id, peerSign.publicKey, serverSign.secretKey);
    this.deliver(
      toBinary(
        RendezvousMessageSchema,
        create(RendezvousMessageSchema, {
          union: {
            case: "relayResponse",
            value: { uuid: "uuid-1", relayServer: "relay.example:21117", union: { case: "pk", value: pk }, version: "1.4.3" },
          },
        }),
      ),
    );
  }

  private ephemeral = nacl.box.keyPair();

  private onRelay(data: Uint8Array): void {
    if (!this.key && data.length > 0) {
      // First message is RequestRelay; answer with SignedId.
      try {
        const rm = fromBinary(RendezvousMessageSchema, data);
        if (rm.union.case === "requestRelay") {
          const signer = behaviour.impostor ? nacl.sign.keyPair().secretKey : peerSign.secretKey;
          this.peerSend({ union: { case: "signedId", value: { id: signedIdPk(PEER_ID, this.ephemeral.publicKey, signer) } } });
          return;
        }
      } catch {
        /* not a rendezvous message */
      }
      const m = fromBinary(MessageSchema, data);
      if (m.union.case === "publicKey") {
        const key = nacl.box.open(m.union.value.symmetricValue, new Uint8Array(24), m.union.value.asymmetricValue, this.ephemeral.secretKey);
        if (!key) throw new Error("peer could not open the symmetric key");
        this.key = key;
        this.peerSend({ union: { case: "hash", value: { salt: SALT, challenge: CHALLENGE } } });
      }
      return;
    }
    this.recvSeq++;
    const plain = nacl.secretbox.open(data, this.nonce(this.recvSeq), this.key!);
    if (!plain) throw new Error("peer could not decrypt");
    const m = fromBinary(MessageSchema, plain);
    peerLog.push(m);
    if (m.union.case === "loginRequest") {
      const lr = m.union.value;
      const expected = sha256(sha256(PASSWORD, SALT), CHALLENGE);
      if (lr.password.length === 0) {
        if (behaviour.requirePassword) return;
        this.peerSend({ union: { case: "loginResponse", value: { union: { case: "error", value: "No Password Access" } } } });
        return;
      }
      if (Buffer.compare(Buffer.from(lr.password), Buffer.from(expected)) !== 0) {
        this.peerSend({ union: { case: "loginResponse", value: { union: { case: "error", value: "Wrong Password" } } } });
        return;
      }
      this.peerSend({
        union: {
          case: "loginResponse",
          value: {
            union: {
              case: "peerInfo",
              value: {
                username: "alice",
                hostname: "box",
                platform: "Windows",
                version: "1.4.3",
                displays: [{ x: 0, y: 0, width: 1920, height: 1080, name: "DISPLAY1", online: true }],
                currentDisplay: 0,
                encoding: { h264: true, vp8: true },
              },
            },
          },
        },
      });
      const rgba = new Uint8Array(2 * 2 * 4).fill(255);
      this.peerSend({
        union: { case: "cursorData", value: { id: "42", hotx: 1, hoty: 1, width: 2, height: 2, colors: new Uint8Array(zstdCompressSync(rgba)) } },
      });
      this.peerSend({ union: { case: "cursorPosition", value: { x: 100, y: 200 } } });
      this.peerSend({ union: { case: "testDelay", value: { time: 5n, lastDelay: 12, targetBitrate: 3000 } } });
    }
  }
}

function newSession(extra: Partial<ConstructorParameters<typeof Session>[0]> = {}): Session {
  return new Session({
    peerId: PEER_ID,
    server: {
      rendezvousUrl: "wss://srv.example/ws/id",
      relayUrl: () => "wss://srv.example/ws/relay",
      key: encodeBase64(serverSign.publicKey),
    },
    ...extra,
  });
}

beforeEach(() => {
  behaviour = {};
  peerLog = [];
  lastRelay = null;
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Session", () => {
  it("authenticates the peer, logs in with a password and handles media messages", async () => {
    const s = newSession();
    const events: string[] = [];
    s.on("password", ({ wrong }) => {
      events.push(`password:${wrong}`);
      void s.login(PASSWORD);
    });
    let remembered: Uint8Array | null = null;
    s.on("connected", (e) => {
      remembered = e.rememberedHash;
    });
    const pos: [number, number][] = [];
    s.on("cursorPosition", ({ x, y }) => pos.push([x, y]));
    behaviour.requirePassword = true;
    await s.connect();
    expect(s.state).toBe("connected");
    expect(events).toEqual(["password:false"]);
    expect(s.peer?.os).toBe("windows");
    expect(s.display?.width).toBe(1920);
    expect(remembered).not.toBeNull();
    expect(Buffer.from(remembered!).toString("hex")).toBe(Buffer.from(sha256(PASSWORD, SALT)).toString("hex"));

    await new Promise((r) => setTimeout(r, 10));
    expect(s.cursor?.id).toBe("42");
    expect(s.cursor?.hotX).toBe(1);
    expect(pos).toEqual([[100, 200]]);
    // TestDelay is echoed back unchanged
    const echoed = peerLog.find((m) => m.union.case === "testDelay");
    expect(echoed?.union.value).toMatchObject({ time: 5n, fromClient: false });

    s.mouseMove(10, 20);
    s.mouseButton("right", true, 10, 20);
    const mouse = peerLog.filter((m) => m.union.case === "mouseEvent").map((m) => m.union.value);
    expect(mouse.map((m) => (m as { mask: number }).mask)).toEqual([0, (2 << 3) | 1]);

    s.key({ code: "KeyA", key: "a", down: true });
    const ke = peerLog.filter((m) => m.union.case === "keyEvent").at(-1)?.union.value as { union: { case: string; value: number } };
    expect(ke.union).toEqual({ case: "chr", value: 0x1e }); // Windows scan code for A
    s.close();
    expect(s.state).toBe("closed");
  });

  it("logs in with a remembered hash without asking", async () => {
    const s = newSession({ rememberedHash: sha256(PASSWORD, SALT) });
    const asked = vi.fn();
    s.on("password", asked);
    await s.connect();
    expect(asked).not.toHaveBeenCalled();
    s.close();
  });

  it("reports a wrong password and waits for another", async () => {
    const s = newSession({ rememberedHash: sha256("nope", SALT) });
    const seen: boolean[] = [];
    s.on("password", ({ wrong }) => {
      seen.push(wrong);
      if (wrong) void s.login(PASSWORD);
    });
    await s.connect();
    expect(seen).toEqual([true]);
    s.close();
  });

  it("waits for remote approval when no password is given", async () => {
    const s = newSession();
    const waiting = new Promise<void>((resolve) => s.on("waitingForApproval", () => resolve()));
    const p = s.connect();
    await waiting;
    s.close();
    await expect(p).rejects.toThrow();
  });

  it("refuses a peer whose session key is not signed by its vouched key", async () => {
    behaviour.impostor = true;
    const s = newSession();
    await expect(s.connect()).rejects.toMatchObject({ code: "handshake" });
    expect(s.state).toBe("closed");
  });

  it("refuses when the server vouches for a different id", async () => {
    behaviour.wrongServerId = true;
    const s = newSession();
    await expect(s.connect()).rejects.toMatchObject({ code: "handshake" });
  });

  it("refuses when the server does not vouch for the peer at all", async () => {
    behaviour.noServerKey = true;
    const s = newSession();
    await expect(s.connect()).rejects.toMatchObject({ code: "unverified-peer" });
    expect(lastRelay).toBeNull();
  });

  it("rejects a malformed server key up front", () => {
    expect(() =>
      new Session({ peerId: "1", server: { rendezvousUrl: "wss://x/ws/id", key: "not-a-key" } }),
    ).toThrow();
  });
});
