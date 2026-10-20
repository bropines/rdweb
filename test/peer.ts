// In-memory hbbs/hbbr/peer for protocol tests: answers the rendezvous,
// authenticates like a real peer (signed keys, sealed session key, salted
// password challenge) and then hands every decrypted message to a handler.
// hbbs can also send its signed KeyExchange on connect and answer
// OnlineRequest, and endpoints can be made unreachable or stall (server check).

import nacl from "tweetnacl";
import { create, fromBinary, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";
import { RendezvousMessageSchema, type OnlineRequest, type PunchHoleRequest, type RequestRelay } from "../src/proto/rendezvous_pb.js";
import {
  IdPkSchema,
  MessageSchema,
  type LoginRequest,
  type Message,
  type PeerInfoSchema,
} from "../src/proto/session_pb.js";
import { encodeBase64 } from "../src/crypto.js";

export const PEER_ID = "123456789";
export const PASSWORD = "s3cret";
export const SALT = "salt-xyz";
export const CHALLENGE = "challenge-abc";

export const serverSign = nacl.sign.keyPair();
const peerSign = nacl.sign.keyPair();

export type PeerInit = MessageInitShape<typeof MessageSchema>;

export interface PeerConfig {
  /** Answer to a correct login (default: a Linux peer info). */
  peerInfo?: MessageInitShape<typeof PeerInfoSchema>;
  /** Refuse the login with this error instead. */
  loginError?: string;
  /** Messages to send right after a successful login. */
  afterLogin?: (peer: FakePeer) => void;
  /** Every message after login. */
  onMessage?: (m: Message, peer: FakePeer) => void;
  /**
   * hbbs sends a KeyExchange as its first frame (as on TCP; real hbbs does not
   * on WebSocket), its key signed with the server key or with another key.
   */
  keyExchange?: "valid" | "wrong-key";
  /** Device ids hbbs reports online in an OnlineResponse. */
  online?: string[];
  /** URLs (substrings) whose WebSocket fails to connect. */
  unreachable?: string[];
  /** URLs (substrings) whose WebSocket never opens. */
  stalled?: string[];
}

export function sha256(...parts: (Uint8Array | string)[]): Uint8Array {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

function signedIdPk(id: string, pk: Uint8Array, sk: Uint8Array): Uint8Array {
  return nacl.sign(toBinary(IdPkSchema, create(IdPkSchema, { id, pk })), sk);
}

/** State of the fake network for one test. */
export class FakeNet {
  config: PeerConfig = {};
  punchRequests: PunchHoleRequest[] = [];
  relayRequests: RequestRelay[] = [];
  loginRequests: LoginRequest[] = [];
  onlineRequests: OnlineRequest[] = [];
  /** URL of every WebSocket the client opened. */
  opened: string[] = [];
  /** Every message the client sent after the key exchange. */
  log: Message[] = [];
  peer: FakePeer | null = null;
}

export let net = new FakeNet();
export function resetNet(config: PeerConfig = {}): FakeNet {
  net = new FakeNet();
  net.config = config;
  return net;
}

export interface FakePeer {
  send(init: PeerInit): void;
  socket: FakeSocket;
  close(): void;
}

export class FakeSocket {
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
  private ephemeral = nacl.box.keyPair();
  private loggedIn = false;

  constructor(readonly url: string) {
    net.opened.push(url);
    const matches = (list?: string[]) => !!list?.some((u) => url.includes(u));
    if (matches(net.config.stalled)) return;
    if (matches(net.config.unreachable)) {
      queueMicrotask(() => {
        this.readyState = 3;
        this.onerror?.();
        this.onclose?.({ code: 1006, reason: "", wasClean: false });
      });
      return;
    }
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
      if (this.url.includes("/ws/id") && net.config.keyExchange) this.sendKeyExchange(net.config.keyExchange === "valid");
    });
  }

  /** hbbs' KeyExchange: keys[0] = its X25519 key signed with the server key. */
  private sendKeyExchange(valid: boolean): void {
    const signer = valid ? serverSign.secretKey : nacl.sign.keyPair().secretKey;
    const signed = nacl.sign(nacl.box.keyPair().publicKey, signer);
    this.deliver(toBinary(RendezvousMessageSchema, create(RendezvousMessageSchema, { union: { case: "keyExchange", value: { keys: [signed] } } })));
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code: 1000, reason: "", wasClean: true }));
  }

  /** The peer drops the connection. */
  drop(reason = "peer went away"): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code: 1006, reason, wasClean: false }));
  }

  private deliver(bytes: Uint8Array): void {
    const copy = bytes.slice().buffer;
    queueMicrotask(() => {
      if (this.readyState === 1) this.onmessage?.({ data: copy });
    });
  }

  private nonce(seq: bigint): Uint8Array {
    const n = new Uint8Array(24);
    new DataView(n.buffer).setBigUint64(0, seq, true);
    return n;
  }

  peerSend(init: PeerInit): void {
    let bytes: Uint8Array = toBinary(MessageSchema, create(MessageSchema, init));
    if (this.key) {
      this.sendSeq++;
      bytes = nacl.secretbox(bytes, this.nonce(this.sendSeq), this.key);
    }
    this.deliver(bytes);
  }

  send(data: Uint8Array): void {
    if (this.readyState !== 1) throw new Error("socket not open");
    if (this.url.includes("/ws/id")) return this.onRendezvous(data);
    return this.onRelay(data);
  }

  private onRendezvous(data: Uint8Array): void {
    const msg = fromBinary(RendezvousMessageSchema, data);
    if (msg.union.case === "onlineRequest") return this.onOnlineRequest(msg.union.value);
    if (msg.union.case !== "punchHoleRequest") return;
    net.punchRequests.push(msg.union.value);
    const pk = signedIdPk(msg.union.value.id, peerSign.publicKey, serverSign.secretKey);
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

  /** A bitmap, MSB first; hbbs closes a stream connection after answering. */
  private onOnlineRequest(req: OnlineRequest): void {
    net.onlineRequests.push(req);
    const states = new Uint8Array(Math.ceil(req.peers.length / 8));
    req.peers.forEach((id, i) => {
      if (net.config.online?.includes(id)) states[i >> 3]! |= 0x80 >> (i & 7);
    });
    this.deliver(toBinary(RendezvousMessageSchema, create(RendezvousMessageSchema, { union: { case: "onlineResponse", value: { states } } })));
    queueMicrotask(() => this.drop("")); // after the answer was delivered
  }

  private onRelay(data: Uint8Array): void {
    if (!this.key) {
      try {
        const rm = fromBinary(RendezvousMessageSchema, data);
        if (rm.union.case === "requestRelay") {
          net.relayRequests.push(rm.union.value);
          this.peerSend({
            union: { case: "signedId", value: { id: signedIdPk(PEER_ID, this.ephemeral.publicKey, peerSign.secretKey) } },
          });
          return;
        }
      } catch {
        /* not a rendezvous message */
      }
      const m = fromBinary(MessageSchema, data);
      if (m.union.case === "publicKey") {
        const key = nacl.box.open(
          m.union.value.symmetricValue,
          new Uint8Array(24),
          m.union.value.asymmetricValue,
          this.ephemeral.secretKey,
        );
        if (!key) throw new Error("peer could not open the symmetric key");
        this.key = key;
        this.peerSend({ union: { case: "hash", value: { salt: SALT, challenge: CHALLENGE } } });
      }
      return;
    }
    this.recvSeq++;
    const plain = nacl.secretbox.open(data, this.nonce(this.recvSeq), this.key);
    if (!plain) throw new Error("peer could not decrypt");
    const m = fromBinary(MessageSchema, plain);
    net.log.push(m);
    if (m.union.case === "loginRequest") return this.onLogin(m.union.value);
    if (this.loggedIn) net.config.onMessage?.(m, net.peer!);
  }

  private onLogin(lr: LoginRequest): void {
    net.loginRequests.push(lr);
    const expected = sha256(sha256(PASSWORD, SALT), CHALLENGE);
    if (lr.password.length === 0) {
      return; // wait for the password
    }
    if (Buffer.compare(Buffer.from(lr.password), Buffer.from(expected)) !== 0) {
      this.peerSend({ union: { case: "loginResponse", value: { union: { case: "error", value: "Wrong Password" } } } });
      return;
    }
    if (net.config.loginError) {
      this.peerSend({ union: { case: "loginResponse", value: { union: { case: "error", value: net.config.loginError } } } });
      return;
    }
    this.loggedIn = true;
    const peerInfo = net.config.peerInfo ?? { username: "alice", hostname: "box", platform: "Linux", version: "1.4.3" };
    this.peerSend({ union: { case: "loginResponse", value: { union: { case: "peerInfo", value: peerInfo } } } });
    net.peer = { send: (init) => this.peerSend(init), socket: this, close: () => this.drop() };
    net.config.afterLogin?.(net.peer);
  }
}

export function serverConfig() {
  return {
    rendezvousUrl: "wss://srv.example/ws/id",
    relayUrl: () => "wss://srv.example/ws/relay",
    key: encodeBase64(serverSign.publicKey),
  };
}
