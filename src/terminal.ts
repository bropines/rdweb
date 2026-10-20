// A remote shell: RustDesk's "Terminal" (ConnType TERMINAL, peers 1.4.1+).
// One link, one or more terminals (tabs, by terminal id; 0 opens with the
// session): bytes both ways, resize, close. The peer runs PowerShell/cmd on
// Windows and the user's shell elsewhere.

import { isRetryable, PeerConnector, SessionError, toSessionError } from "./connector.js";
import { parseServerKey } from "./crypto.js";
import { Emitter } from "./emitter.js";
import { peerOsFromPlatform, type PeerOs } from "./keymap.js";
import { ConnType } from "./proto/rendezvous_pb.js";
import type { Message, PeerInfo, TerminalResponse } from "./proto/session_pb.js";
import type { CloseInfo, ServerConfig, SessionState } from "./types.js";
import { inflateCapped } from "./zstd.js";

const FIRST_TERMINAL = 0;
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
  /** Output of a shell (UTF-8 bytes, may split characters). */
  data: { terminalId: number; data: Uint8Array };
  /** A shell exited; the session closes when the last one did. */
  exit: { terminalId: number; code: number };
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
  private readonly sizes = new Map<number, { cols: number; rows: number }>();
  private readonly opening = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  private readonly open = new Set<number>();

  constructor(opts: TerminalOptions) {
    this.peerId = opts.peerId.replace(/\s+/g, "");
    if (!this.peerId) throw new SessionError("peer id is empty", "bad-config");
    parseServerKey(opts.server.key);
    this.sizes.set(FIRST_TERMINAL, { cols: opts.cols ?? 80, rows: opts.rows ?? 24 });
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

  /** Connects, logs in and opens the first shell (terminal 0). May emit password/twoFactor/waitingForApproval while waiting. */
  async connect(): Promise<void> {
    if (this.stateValue !== "idle") throw new SessionError("connect() can only be called once", "state");
    try {
      await this.link.connect(this.abort.signal);
      const size = this.sizes.get(FIRST_TERMINAL)!;
      await this.request(FIRST_TERMINAL, size.cols, size.rows);
      this.setState("connected");
      this.events.emit("connected", { peer: this.peerInfo!, rememberedHash: this.link.rememberedHash });
    } catch (e) {
      const err = toSessionError(e);
      this.shutdown({ reason: err.message, remote: false, retryable: isRetryable(err) });
      throw err;
    }
  }

  /** Opens another shell on the same connection (a tab); ids are chosen by the caller, unique per session. */
  async openTerminal(terminalId: number, cols: number, rows: number): Promise<void> {
    if (this.stateValue !== "connected") throw new SessionError("not connected", "state");
    if (this.open.has(terminalId) || this.opening.has(terminalId)) throw new SessionError(`terminal ${terminalId} is already open`, "state");
    this.sizes.set(terminalId, { cols, rows });
    await this.request(terminalId, cols, rows);
  }

  /** Ids of the open shells. */
  get terminals(): number[] {
    return [...this.open].sort((a, b) => a - b);
  }

  private request(terminalId: number, cols: number, rows: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.opening.delete(terminalId);
        reject(new SessionError("the device did not open a terminal", "timeout"));
      }, OPEN_TIMEOUT_MS);
      this.opening.set(terminalId, {
        resolve: () => {
          clearTimeout(timer);
          this.open.add(terminalId);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.link.send({
        union: { case: "terminalAction", value: { union: { case: "open", value: { terminalId, rows, cols } } } },
      });
    });
  }

  login(password: string): Promise<void> {
    return this.link.login(password);
  }

  submitTwoFactor(code: string): void {
    this.link.submitTwoFactor(code);
  }

  /** Sends keystrokes / pasted text to a shell (default: the first one). */
  write(data: string | Uint8Array, terminalId = FIRST_TERMINAL): void {
    if (this.stateValue !== "connected" || !this.open.has(terminalId)) return;
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (!bytes.length) return;
    this.link.send({
      union: { case: "terminalAction", value: { union: { case: "data", value: { terminalId, data: bytes, compressed: false } } } },
    });
  }

  resize(cols: number, rows: number, terminalId = FIRST_TERMINAL): void {
    cols = Math.max(1, Math.floor(cols));
    rows = Math.max(1, Math.floor(rows));
    const old = this.sizes.get(terminalId);
    if (old && old.cols === cols && old.rows === rows) return;
    this.sizes.set(terminalId, { cols, rows });
    if (this.stateValue !== "connected" || !this.open.has(terminalId)) return;
    this.link.send({
      union: { case: "terminalAction", value: { union: { case: "resize", value: { terminalId, rows, cols } } } },
    });
  }

  /** Closes one shell (a tab); the session stays up. */
  closeTerminal(terminalId: number): void {
    if (!this.open.has(terminalId) || !this.link.isOpen) return;
    this.link.send({ union: { case: "terminalAction", value: { union: { case: "close", value: { terminalId } } } } });
  }

  close(reason = "closed by user"): void {
    if (this.stateValue === "closed") return;
    if (this.link.isOpen) {
      try {
        for (const terminalId of this.open) {
          this.link.send({ union: { case: "terminalAction", value: { union: { case: "close", value: { terminalId } } } } });
        }
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
          for (const o of this.opening.values()) o.reject(new SessionError(reason, "remote-closed"));
          this.opening.clear();
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
      case "opened": {
        const o = this.opening.get(u.value.terminalId);
        this.opening.delete(u.value.terminalId);
        if (u.value.success) o?.resolve();
        else o?.reject(new SessionError(u.value.message || "the device could not open a terminal", "refused"));
        return;
      }
      case "data": {
        let data = u.value.data;
        if (u.value.compressed) {
          try {
            data = inflateCapped(data, MAX_CHUNK);
          } catch {
            return;
          }
        }
        if (data.length) this.events.emit("data", { terminalId: u.value.terminalId, data });
        return;
      }
      case "closed": {
        const id = u.value.terminalId;
        if (!this.open.delete(id)) return;
        this.events.emit("exit", { terminalId: id, code: u.value.exitCode });
        if (this.open.size === 0 && this.opening.size === 0) this.shutdown({ reason: "the shell exited", remote: true, retryable: false });
        return;
      }
      case "error": {
        const o = this.opening.get(u.value.terminalId);
        if (o) {
          this.opening.delete(u.value.terminalId);
          o.reject(new SessionError(u.value.message, "refused"));
        } else {
          this.events.emit("data", { terminalId: u.value.terminalId, data: new TextEncoder().encode(`\r\n[${u.value.message}]\r\n`) });
        }
        return;
      }
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
    for (const o of this.opening.values()) o.reject(new SessionError(info.reason, "closed"));
    this.opening.clear();
    this.open.clear();
    this.abort.abort();
    this.link.close(info.reason);
    this.setState("closed");
    this.events.emit("close", info);
  }
}
