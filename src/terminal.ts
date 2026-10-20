// A remote shell: RustDesk's "Terminal" (ConnType TERMINAL, peers 1.4.1+).
// One link, one terminal: bytes both ways, resize, close. The peer runs
// PowerShell/cmd on Windows and the user's shell elsewhere.

import { isRetryable, PeerConnector, SessionError, toSessionError } from "./connector.js";
import { parseServerKey } from "./crypto.js";
import { Emitter } from "./emitter.js";
import { peerOsFromPlatform, type PeerOs } from "./keymap.js";
import { ConnType } from "./proto/rendezvous_pb.js";
import type { Message, PeerInfo, TerminalResponse } from "./proto/session_pb.js";
import type { CloseInfo, ServerConfig, SessionState } from "./types.js";
import { inflateCapped } from "./zstd.js";

const TERMINAL_ID = 0;
const OPEN_TIMEOUT_MS = 20_000;
const MAX_CHUNK = 4 << 20;

export interface TerminalOptions {
  server: ServerConfig;
  peerId: string;
  /** Stored SHA256(password || salt) from an earlier "remember password". */
  rememberedHash?: Uint8Array;
  myName?: string;
  myId?: string;
  clientVersion?: string;
  /** Initial size in character cells (default 80x24). */
  cols?: number;
  rows?: number;
}

export interface TerminalPeer {
  id: string;
  username: string;
  hostname: string;
  platform: string;
  os: PeerOs;
  version: string;
}

export interface TerminalEventMap {
  state: { state: SessionState };
  password: { wrong: boolean };
  twoFactor: { wrong: boolean };
  waitingForApproval: Record<string, never>;
  connected: { peer: TerminalPeer; rememberedHash: Uint8Array | null };
  /** Output of the shell (UTF-8 bytes, may split characters). */
  data: { data: Uint8Array };
  /** The shell exited. */
  exit: { code: number };
  close: CloseInfo;
}

export class TerminalSession {
  readonly peerId: string;
  private readonly events = new Emitter<TerminalEventMap>();
  private readonly abort = new AbortController();
  private readonly link: PeerConnector;
  private stateValue: SessionState = "idle";
  private peerInfo: TerminalPeer | null = null;
  private closedInfo: CloseInfo | null = null;
  private cols: number;
  private rows: number;
  private opened: { resolve: () => void; reject: (e: Error) => void } | null = null;

  constructor(opts: TerminalOptions) {
    this.peerId = opts.peerId.replace(/\s+/g, "");
    if (!this.peerId) throw new SessionError("peer id is empty", "bad-config");
    parseServerKey(opts.server.key);
    this.cols = opts.cols ?? 80;
    this.rows = opts.rows ?? 24;
    this.link = new PeerConnector(
      {
        peerId: this.peerId,
        server: opts.server,
        connType: ConnType.TERMINAL,
        rememberedHash: opts.rememberedHash,
        myName: opts.myName,
        myId: opts.myId,
        clientVersion: opts.clientVersion,
        loginExtras: () => ({ union: { case: "terminal", value: { serviceId: "" } } }),
        loginErrorCode: (e) => (/no permission|not allowed|disabled/i.test(e) ? "permission-denied" : "login"),
      },
      {
        state: (state) => this.setState(state),
        password: (wrong) => this.events.emit("password", { wrong }),
        twoFactor: (wrong) => this.events.emit("twoFactor", { wrong }),
        waitingForApproval: () => this.events.emit("waitingForApproval", {}),
        loggedIn: (pi) => this.applyPeerInfo(pi),
        message: (msg) => this.onMessage(msg),
        failed: (info) => this.shutdown(info),
      },
    );
  }

  get state(): SessionState {
    return this.stateValue;
  }

  get peer(): TerminalPeer | null {
    return this.peerInfo;
  }

  get closeInfo(): CloseInfo | null {
    return this.closedInfo;
  }

  on<K extends keyof TerminalEventMap>(type: K, fn: (ev: TerminalEventMap[K]) => void): () => void {
    return this.events.on(type, fn);
  }

  /** Connects, logs in and opens the shell. May emit password/twoFactor/waitingForApproval while waiting. */
  async connect(): Promise<void> {
    if (this.stateValue !== "idle") throw new SessionError("connect() can only be called once", "state");
    try {
      await this.link.connect(this.abort.signal);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new SessionError("the device did not open a terminal", "timeout")), OPEN_TIMEOUT_MS);
        this.opened = {
          resolve: () => (clearTimeout(timer), resolve()),
          reject: (e) => (clearTimeout(timer), reject(e)),
        };
        this.link.send({
          union: { case: "terminalAction", value: { union: { case: "open", value: { terminalId: TERMINAL_ID, rows: this.rows, cols: this.cols } } } },
        });
      });
      this.setState("connected");
      this.events.emit("connected", { peer: this.peerInfo!, rememberedHash: this.link.rememberedHash });
    } catch (e) {
      const err = toSessionError(e);
      this.shutdown({ reason: err.message, remote: false, retryable: isRetryable(err) });
      throw err;
    }
  }

  login(password: string): Promise<void> {
    return this.link.login(password);
  }

  submitTwoFactor(code: string): void {
    this.link.submitTwoFactor(code);
  }

  /** Sends keystrokes / pasted text to the shell. */
  write(data: string | Uint8Array): void {
    if (this.stateValue !== "connected") return;
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (!bytes.length) return;
    this.link.send({
      union: { case: "terminalAction", value: { union: { case: "data", value: { terminalId: TERMINAL_ID, data: bytes, compressed: false } } } },
    });
  }

  resize(cols: number, rows: number): void {
    cols = Math.max(1, Math.floor(cols));
    rows = Math.max(1, Math.floor(rows));
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    if (this.stateValue !== "connected") return;
    this.link.send({
      union: { case: "terminalAction", value: { union: { case: "resize", value: { terminalId: TERMINAL_ID, rows, cols } } } },
    });
  }

  close(reason = "closed by user"): void {
    if (this.stateValue === "closed") return;
    if (this.link.isOpen) {
      try {
        this.link.send({ union: { case: "terminalAction", value: { union: { case: "close", value: { terminalId: TERMINAL_ID } } } } });
        this.link.send({ union: { case: "misc", value: { union: { case: "closeReason", value: reason } } } });
      } catch {
        /* ignore */
      }
    }
    this.shutdown({ reason, remote: false, retryable: false });
  }

  private onMessage(msg: Message): void {
    const u = msg.union;
    switch (u.case) {
      case "terminalResponse":
        this.onTerminal(u.value);
        return;
      case "testDelay":
        if (!u.value.fromClient) this.link.send({ union: { case: "testDelay", value: u.value } });
        return;
      case "peerInfo":
        this.applyPeerInfo(u.value);
        return;
      case "misc":
        if (u.value.union.case === "closeReason") {
          const reason = u.value.union.value || "closed by the remote side";
          this.link.rejectLogin(new SessionError(reason, "remote-closed"));
          this.opened?.reject(new SessionError(reason, "remote-closed"));
          this.shutdown({ reason, remote: true, retryable: false });
        }
        return;
      default:
        return;
    }
  }

  private onTerminal(r: TerminalResponse): void {
    const u = r.union;
    switch (u.case) {
      case "opened":
        if (u.value.success) this.opened?.resolve();
        else this.opened?.reject(new SessionError(u.value.message || "the device could not open a terminal", "refused"));
        this.opened = null;
        return;
      case "data": {
        let data = u.value.data;
        if (u.value.compressed) {
          try {
            data = inflateCapped(data, MAX_CHUNK);
          } catch {
            return;
          }
        }
        if (data.length) this.events.emit("data", { data });
        return;
      }
      case "closed":
        this.events.emit("exit", { code: u.value.exitCode });
        this.shutdown({ reason: "the shell exited", remote: true, retryable: false });
        return;
      case "error":
        if (this.opened) {
          this.opened.reject(new SessionError(u.value.message, "refused"));
          this.opened = null;
        } else {
          this.events.emit("data", { data: new TextEncoder().encode(`\r\n[${u.value.message}]\r\n`) });
        }
        return;
      default:
        return;
    }
  }

  private applyPeerInfo(pi: PeerInfo): void {
    this.peerInfo = {
      id: this.peerId,
      username: pi.username,
      hostname: pi.hostname,
      platform: pi.platform,
      os: peerOsFromPlatform(pi.platform),
      version: pi.version,
    };
  }

  private setState(state: SessionState): void {
    if (state === this.stateValue || this.stateValue === "closed") return;
    this.stateValue = state;
    this.events.emit("state", { state });
  }

  private shutdown(info: CloseInfo): void {
    if (this.stateValue === "closed") return;
    this.closedInfo = info;
    this.opened?.reject(new SessionError(info.reason, "closed"));
    this.opened = null;
    this.abort.abort();
    this.link.close(info.reason);
    this.setState("closed");
    this.events.emit("close", info);
  }
}
