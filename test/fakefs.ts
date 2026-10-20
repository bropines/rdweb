// A remote file system behind the fake peer, answering file actions the way
// a peer does: listings with id 0, a job's file list before its data, a
// digest per file that waits for our confirmation, 128 KiB blocks (zstd
// compressed when that helps), an empty block at the end of each file, and
// done/error per job; uploads are checked against existing files.

import { zstdCompressSync } from "node:zlib";
import type { Message } from "../src/proto/session_pb.js";
import { FileType } from "../src/proto/session_pb.js";
import type { FakePeer } from "./peer.js";

type FsNode = { kind: "dir"; mtime: number; hidden?: boolean } | { kind: "file"; data: Uint8Array; mtime: number; hidden?: boolean };

export interface FsBehaviour {
  compress?: "never" | "always" | "alternate";
  /** Behave like a peer older than 1.1.10 (no digests). */
  noDigest?: boolean;
  blockSize?: number;
  /** Milliseconds between blocks (default: next macrotask). */
  blockDelay?: number;
  /** Rewrite a download block before it is sent. */
  tamper?: (fileNum: number, blk: number, block: { data: Uint8Array; compressed: boolean }) => { data: Uint8Array; compressed: boolean };
  /** Paths that fail with "Permission denied". */
  denied?: string[];
  /** Replace a job's file list names (to send hostile names). */
  rename?: (name: string) => string;
}

interface WriteJob {
  path: string;
  files: { name: string; mtime: number }[];
  current: number;
  data: Uint8Array[];
  resumeFrom: Uint8Array | null;
}

const ENOENT = "No such file or directory (os error 2)";
const EACCES = "Permission denied (os error 13)";

function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

function join(dir: string, name: string): string {
  if (!name) return dir;
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

export class FakeFs {
  readonly nodes = new Map<string, FsNode>();
  readonly home = "/home/alice";
  /** Partial uploads left by a dropped connection: path -> data + digest. */
  readonly partials = new Map<string, { data: Uint8Array; size: number; mtime: number }>();
  readonly cancelled = new Set<number>();
  /** Confirmations received for downloads: "id:fileNum:skip|offset". */
  readonly confirms: string[] = [];
  private readonly waiting = new Map<string, (c: { skip: boolean; offset: number } | null) => void>();
  private readonly writes = new Map<number, WriteJob>();

  constructor(public behaviour: FsBehaviour = {}) {
    this.mkdirp(this.home);
  }

  mkdirp(path: string, mtime = 1_700_000_000): void {
    if (path === "/" || this.nodes.has(path)) return;
    this.mkdirp(parentOf(path), mtime);
    this.nodes.set(path, { kind: "dir", mtime });
  }

  writeFile(path: string, data: Uint8Array | string, mtime = 1_700_000_000, hidden = false): void {
    this.mkdirp(parentOf(path));
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    this.nodes.set(path, { kind: "file", data: bytes, mtime, hidden });
  }

  file(path: string): Uint8Array | null {
    const n = this.nodes.get(path);
    return n?.kind === "file" ? n.data : null;
  }

  text(path: string): string | null {
    const d = this.file(path);
    return d ? new TextDecoder().decode(d) : null;
  }

  private children(path: string, hidden: boolean): [string, FsNode][] {
    return [...this.nodes].filter(
      ([p, n]) => p !== path && parentOf(p) === path && (hidden || !(n.hidden || p.slice(p.lastIndexOf("/") + 1).startsWith("."))),
    );
  }

  private recursiveFiles(root: string, hidden: boolean, prefix = ""): { name: string; path: string; node: FsNode & { kind: "file" } }[] {
    const out: { name: string; path: string; node: FsNode & { kind: "file" } }[] = [];
    for (const [p, n] of this.children(root, hidden).sort(([a], [b]) => a.localeCompare(b))) {
      const name = p.slice(p.lastIndexOf("/") + 1);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (n.kind === "file") out.push({ name: rel, path: p, node: n });
      else out.push(...this.recursiveFiles(p, hidden, rel));
    }
    return out;
  }

  private denied(path: string): boolean {
    return (this.behaviour.denied ?? []).some((d) => path === d || path.startsWith(`${d}/`));
  }

  // -------------------------------------------------------------- dispatch

  handle(m: Message, peer: FakePeer): void {
    const u = m.union;
    if (u.case === "fileAction") {
      const a = u.value.union;
      switch (a.case) {
        case "readDir":
          return this.readDir(peer, a.value.path, a.value.includeHidden);
        case "send":
          void this.runRead(peer, a.value.id, a.value.path, a.value.includeHidden);
          return;
        case "sendConfirm": {
          const c = a.value;
          const skip = c.union.case === "skip" && c.union.value;
          const offset = c.union.case === "offsetBlk" ? c.union.value : 0;
          const w = this.writes.get(c.id);
          if (w) {
            if (!skip && offset > 0) {
              const target = join(w.path, w.files[c.fileNum]!.name);
              w.resumeFrom = this.partials.get(target)?.data.slice(0, offset) ?? null;
            }
            return;
          }
          this.confirms.push(`${c.id}:${c.fileNum}:${skip ? "skip" : offset}`);
          this.waiting.get(`${c.id}:${c.fileNum}`)?.({ skip, offset });
          return;
        }
        case "cancel":
          this.cancelled.add(a.value.id);
          this.writes.delete(a.value.id);
          for (const [k, resolve] of this.waiting) if (k.startsWith(`${a.value.id}:`)) resolve(null);
          return;
        case "receive": {
          const r = a.value;
          if (this.denied(r.path)) return this.error(peer, r.id, EACCES, 0);
          this.writes.set(r.id, {
            path: r.path,
            files: r.files.map((f) => ({ name: f.name, mtime: Number(f.modifiedTime) })),
            current: -1,
            data: [],
            resumeFrom: null,
          });
          return;
        }
        case "create": {
          if (this.denied(a.value.path)) return this.error(peer, a.value.id, EACCES, 0);
          this.mkdirp(a.value.path);
          return this.done(peer, a.value.id, 0);
        }
        case "removeFile": {
          const { id, path, fileNum } = a.value;
          if (this.denied(path)) return this.error(peer, id, EACCES, fileNum);
          if (this.nodes.get(path)?.kind !== "file") return this.error(peer, id, ENOENT, fileNum);
          this.nodes.delete(path);
          return this.done(peer, id, fileNum);
        }
        case "removeDir": {
          const { id, path, recursive } = a.value;
          if (this.nodes.get(path)?.kind !== "dir") return this.error(peer, id, ENOENT, 0);
          if (recursive) {
            // only empty folders go; files must have been removed one by one
            const dirs = [...this.nodes].filter(([p, n]) => n.kind === "dir" && (p === path || p.startsWith(`${path}/`)));
            for (const [p] of dirs.sort(([x], [y]) => y.length - x.length)) {
              if (this.children(p, true).length === 0) this.nodes.delete(p);
            }
          } else if (this.children(path, true).length) {
            return this.error(peer, id, "Directory not empty (os error 39)", 0);
          } else {
            this.nodes.delete(path);
          }
          return this.done(peer, id, 0);
        }
        case "allFiles": {
          const { id, path, includeHidden } = a.value;
          if (!this.nodes.has(path)) return this.error(peer, id, ENOENT, -1);
          const files = this.recursiveFiles(path, includeHidden);
          peer.send({
            union: {
              case: "fileResponse",
              value: {
                union: {
                  case: "dir",
                  value: { id, path, entries: files.map((f) => ({ entryType: FileType.File, name: f.name, size: BigInt(f.node.data.length) })) },
                },
              },
            },
          });
          return;
        }
        case "rename": {
          const { id, path, newName } = a.value;
          if (!this.nodes.has(path)) return this.error(peer, id, `${JSON.stringify(path)} not exists`, 0);
          const target = join(parentOf(path), newName);
          for (const [p, n] of [...this.nodes]) {
            if (p === path || p.startsWith(`${path}/`)) {
              this.nodes.delete(p);
              this.nodes.set(target + p.slice(path.length), n);
            }
          }
          return this.done(peer, id, 0);
        }
        default:
          return;
      }
    }
    if (u.case === "fileResponse") {
      const r = u.value.union;
      switch (r.case) {
        case "digest":
          return this.checkDigest(peer, r.value.id, r.value.fileNum, Number(r.value.fileSize), Number(r.value.lastModified), r.value.isResume);
        case "block": {
          const w = this.writes.get(r.value.id);
          if (!w) return;
          if (r.value.fileNum !== w.current) {
            this.finalize(w);
            w.current = r.value.fileNum;
            w.data = w.resumeFrom ? [w.resumeFrom] : [];
            w.resumeFrom = null;
          }
          w.data.push(r.value.data.slice());
          return;
        }
        case "done": {
          const w = this.writes.get(r.value.id);
          if (!w) return;
          this.finalize(w);
          this.writes.delete(r.value.id);
          return this.done(peer, r.value.id, r.value.fileNum);
        }
        case "error": {
          if (!this.writes.delete(r.value.id)) return;
          return this.error(peer, r.value.id, r.value.error, r.value.fileNum);
        }
        default:
          return;
      }
    }
  }

  // ---------------------------------------------------------------- pieces

  private readDir(peer: FakePeer, path: string, hidden: boolean): void {
    const p = path || this.home;
    const n = this.nodes.get(p);
    if (this.denied(p)) return this.error(peer, 0, EACCES, -1);
    if (!n || n.kind !== "dir") return this.error(peer, 0, ENOENT, -1);
    const entries = this.children(p, hidden).map(([cp, cn]) => {
      const name = cp.slice(cp.lastIndexOf("/") + 1);
      return {
        entryType: cn.kind === "dir" ? FileType.Dir : FileType.File,
        name,
        isHidden: !!cn.hidden || name.startsWith("."),
        size: BigInt(cn.kind === "file" ? cn.data.length : 0),
        modifiedTime: BigInt(cn.mtime),
      };
    });
    peer.send({ union: { case: "fileResponse", value: { union: { case: "dir", value: { id: 0, path: p, entries } } } } });
  }

  private waitConfirm(id: number, fileNum: number): Promise<{ skip: boolean; offset: number } | null> {
    if (this.cancelled.has(id)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const key = `${id}:${fileNum}`;
      this.waiting.set(key, (c) => {
        this.waiting.delete(key);
        resolve(c);
      });
    });
  }

  private async runRead(peer: FakePeer, id: number, path: string, hidden: boolean): Promise<void> {
    const node = this.nodes.get(path);
    if (this.denied(path)) return this.error(peer, id, EACCES, 0);
    if (!node) return this.error(peer, id, ENOENT, 0);
    const files =
      node.kind === "file" ? [{ name: "", path, node }] : this.recursiveFiles(path, hidden);
    const rename = this.behaviour.rename ?? ((n: string) => n);
    peer.send({
      union: {
        case: "fileResponse",
        value: {
          union: {
            case: "dir",
            value: {
              id,
              path,
              entries: files.map((f) => ({
                entryType: FileType.File,
                name: rename(f.name),
                size: BigInt(f.node.data.length),
                modifiedTime: BigInt(f.node.mtime),
              })),
            },
          },
        },
      },
    });
    const bs = this.behaviour.blockSize ?? 128 * 1024;
    let skippedLast = false;
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      await tick();
      if (this.cancelled.has(id)) return;
      if (!this.behaviour.noDigest) {
        peer.send({
          union: {
            case: "fileResponse",
            value: {
              union: {
                case: "digest",
                value: { id, fileNum: i, lastModified: BigInt(f.node.mtime), fileSize: BigInt(f.node.data.length) },
              },
            },
          },
        });
        const c = await this.waitConfirm(id, i);
        if (!c) return;
        if (c.skip) {
          skippedLast = true;
          continue;
        }
      }
      skippedLast = false;
      const data = f.node.data;
      for (let off = 0, blk = 0; off < data.length; off += bs, blk++) {
        await tick(this.behaviour.blockDelay ?? 0);
        if (this.cancelled.has(id)) return;
        const raw = data.subarray(off, Math.min(off + bs, data.length));
        const mode = this.behaviour.compress ?? "alternate";
        let block = { data: raw, compressed: false };
        if (mode === "always" || (mode === "alternate" && blk % 2 === 0)) {
          const z = new Uint8Array(zstdCompressSync(raw));
          block = { data: z, compressed: true };
        }
        if (this.behaviour.tamper) block = this.behaviour.tamper(i, blk, block);
        peer.send({ union: { case: "fileResponse", value: { union: { case: "block", value: { id, fileNum: i, ...block } } } } });
      }
      await tick();
      if (this.cancelled.has(id)) return;
      peer.send({ union: { case: "fileResponse", value: { union: { case: "block", value: { id, fileNum: i } } } } });
    }
    await tick();
    if (this.cancelled.has(id)) return;
    if (files.length === 1 && skippedLast) this.error(peer, id, "skipped", 1);
    else this.done(peer, id, files.length);
  }

  private checkDigest(peer: FakePeer, id: number, fileNum: number, size: number, mtime: number, isResume: boolean): void {
    const w = this.writes.get(id);
    if (!w) return;
    const target = join(w.path, w.files[fileNum]!.name);
    const partial = this.partials.get(target);
    if (isResume && partial && partial.size === size && partial.mtime === mtime && partial.data.length > 0) {
      peer.send({
        union: {
          case: "fileResponse",
          value: {
            union: {
              case: "digest",
              value: {
                id,
                fileNum,
                isUpload: true,
                isIdentical: true,
                transferredSize: BigInt(partial.data.length),
                fileSize: BigInt(size),
                lastModified: BigInt(mtime),
              },
            },
          },
        },
      });
      return;
    }
    const existing = this.nodes.get(target);
    if (existing?.kind === "file") {
      peer.send({
        union: {
          case: "fileResponse",
          value: {
            union: {
              case: "digest",
              value: {
                id,
                fileNum,
                isUpload: true,
                isIdentical: existing.data.length === size && existing.mtime === mtime,
                fileSize: BigInt(existing.data.length),
                lastModified: BigInt(existing.mtime),
              },
            },
          },
        },
      });
      return;
    }
    peer.send({
      union: { case: "fileAction", value: { union: { case: "sendConfirm", value: { id, fileNum, union: { case: "offsetBlk", value: 0 } } } } },
    });
  }

  private finalize(w: WriteJob): void {
    if (w.current < 0) return;
    const f = w.files[w.current]!;
    const target = join(w.path, f.name);
    this.writeFile(target, concat(w.data), f.mtime);
    this.partials.delete(target);
    w.current = -1;
    w.data = [];
  }

  private done(peer: FakePeer, id: number, fileNum: number): void {
    peer.send({ union: { case: "fileResponse", value: { union: { case: "done", value: { id, fileNum } } } } });
  }

  private error(peer: FakePeer, id: number, error: string, fileNum: number): void {
    peer.send({ union: { case: "fileResponse", value: { union: { case: "error", value: { id, error, fileNum } } } } });
  }
}
