// FileTransferSession against the in-memory server/peer and a fake remote
// file system: login as a file transfer, listings, downloads (compressed and
// plain blocks, folders, skip, cancel), uploads (conflicts, skip, resume,
// backpressure), file operations, peer errors and hostile peers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zstdCompressSync } from "node:zlib";
import { ConnType } from "../src/proto/rendezvous_pb.js";
import { PermissionInfo_Permission } from "../src/proto/session_pb.js";
import { FileTransferSession } from "../src/files/session.js";
import { FileTransferError, type FileErrorEvent, type TransferProgress } from "../src/files/types.js";
import { FakeFs, type FsBehaviour } from "./fakefs.js";
import { FakeSocket, PASSWORD, PEER_ID, net, resetNet, serverConfig, sha256, SALT, type PeerConfig } from "./peer.js";

let fs: FakeFs;

function setup(behaviour: FsBehaviour = {}, config: PeerConfig = {}): FakeFs {
  fs = new FakeFs(behaviour);
  resetNet({
    afterLogin: (peer) => {
      // like a peer: list the requested folder (or home) right after login
      const ft = net.loginRequests.at(-1)?.union;
      const dir = ft?.case === "fileTransfer" ? ft.value.dir : "";
      fs.handle(
        { union: { case: "fileAction", value: { union: { case: "readDir", value: { path: dir, includeHidden: false } } } } } as never,
        peer,
      );
    },
    onMessage: (m, peer) => fs.handle(m, peer),
    ...config,
  });
  return fs;
}

async function connected(extra: Partial<ConstructorParameters<typeof FileTransferSession>[0]> = {}): Promise<FileTransferSession> {
  const s = new FileTransferSession({
    peerId: PEER_ID,
    server: serverConfig(),
    rememberedHash: sha256(PASSWORD, SALT),
    requestTimeoutMs: 2000,
    ...extra,
  });
  await s.connect();
  return s;
}

function bytes(n: number, seed = 1): Uint8Array<ArrayBuffer> {
  // compressible but not trivial
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    if (i % 64 === 0) x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (x >> (i % 16)) & 0xff;
  }
  return out;
}

async function collect(it: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const c of it) parts.push(c);
  return new Uint8Array(Buffer.concat(parts));
}

const sent = (kind: string) =>
  net.log.filter((m) => m.union.case === "fileAction" && m.union.value.union.case === kind).map((m) => (m.union.value as { union: { value: unknown } }).union.value);

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FileTransferSession: connect and list", () => {
  it("logs in as a file transfer and lists folders", async () => {
    setup();
    fs.writeFile("/home/alice/notes.txt", "hello", 1_700_000_123);
    fs.writeFile("/home/alice/.secret", "x");
    fs.mkdirp("/home/alice/docs");
    const s = new FileTransferSession({ peerId: PEER_ID, server: serverConfig(), showHidden: false, initialDir: "" });
    const asked: boolean[] = [];
    s.on("password", ({ wrong }) => {
      asked.push(wrong);
      void s.login(PASSWORD);
    });
    let home: string | undefined;
    s.on("connected", (e) => (home = e.home?.path));
    await s.connect();
    expect(asked).toEqual([false]);
    expect(s.state).toBe("connected");
    expect(home).toBe("/home/alice");
    expect(s.homeDir).toBe("/home/alice");
    expect(s.peer?.os).toBe("linux");
    expect(s.separator).toBe("/");

    // file transfer on the wire: rendezvous, relay and login
    expect(net.punchRequests[0]?.connType).toBe(ConnType.FILE_TRANSFER);
    expect(net.relayRequests[0]?.connType).toBe(ConnType.FILE_TRANSFER);
    const lr = net.loginRequests.at(-1)!;
    expect(lr.union).toMatchObject({ case: "fileTransfer", value: { dir: "", showHidden: false } });
    expect(lr.videoAckRequired).toBe(false);
    expect(lr.option).toBeUndefined();

    const dir = await s.listDir("/home/alice");
    expect(dir.path).toBe("/home/alice");
    expect(dir.entries.map((e) => [e.name, e.type]).sort()).toEqual([
      ["docs", "dir"],
      ["notes.txt", "file"],
    ]);
    const notes = dir.entries.find((e) => e.name === "notes.txt")!;
    expect(notes).toMatchObject({ size: 5, modified: 1_700_000_123_000, hidden: false });

    const all = await s.listDir("/home/alice", { showHidden: true });
    expect(all.entries.find((e) => e.name === ".secret")?.hidden).toBe(true);

    // concurrent listings are answered in order
    const [a, b] = await Promise.all([s.listDir("/home/alice/docs"), s.listDir("")]);
    expect(a.path).toBe("/home/alice/docs");
    expect(b.path).toBe("/home/alice");
    s.close();
    expect(s.state).toBe("closed");
  });

  it("reports a failed listing as a typed error", async () => {
    setup();
    const s = await connected();
    const errors: FileErrorEvent[] = [];
    s.on("error", (e) => errors.push(e));
    await expect(s.listDir("/nope")).rejects.toMatchObject({ code: "not-found", path: "/nope" });
    expect(errors[0]).toMatchObject({ code: "not-found", remoteMessage: "No such file or directory (os error 2)" });
    // the session keeps working
    expect((await s.listDir("")).path).toBe("/home/alice");
    s.close();
  });

  it("refuses a peer without file transfer permission", async () => {
    setup({}, { loginError: "No permission of file transfer" });
    const s = new FileTransferSession({ peerId: PEER_ID, server: serverConfig(), rememberedHash: sha256(PASSWORD, SALT) });
    await expect(s.connect()).rejects.toMatchObject({ code: "permission-denied" });
    expect(s.state).toBe("closed");
  });

  it("refuses when nobody is logged on at the peer", async () => {
    setup({}, { peerInfo: { username: "", platform: "Linux", version: "1.4.3" } });
    const s = new FileTransferSession({ peerId: PEER_ID, server: serverConfig(), rememberedHash: sha256(PASSWORD, SALT) });
    await expect(s.connect()).rejects.toMatchObject({ code: "no-user" });
  });

  it("picks the current Windows session before the first listing", async () => {
    setup(
      {},
      {
        peerInfo: {
          username: "bob",
          platform: "Windows",
          version: "1.4.3",
          windowsSessions: { sessions: [{ sid: 1, name: "Console" }, { sid: 2, name: "RDP" }], currentSid: 2 },
        },
        afterLogin: () => {},
        onMessage: (m, peer) => {
          if (m.union.case === "misc" && m.union.value.union.case === "selectedSid") {
            peer.send({
              union: {
                case: "fileResponse",
                value: { union: { case: "dir", value: { id: 0, path: "C:\\Users\\bob", entries: [] } } },
              },
            });
          }
        },
      },
    );
    const s = await connected();
    expect(s.homeDir).toBe("C:\\Users\\bob");
    expect(s.separator).toBe("\\");
    expect(s.joinPath("/", "C:")).toBe("C:\\");
    expect(s.joinPath("C:\\Users\\bob", "a.txt")).toBe("C:\\Users\\bob\\a.txt");
    expect(s.parentPath("C:\\Users")).toBe("C:\\");
    expect(s.parentPath("C:\\")).toBe("/");
    s.close();
  });

  it("answers the peer's round-trip probes", async () => {
    setup();
    const s = await connected();
    net.peer!.send({ union: { case: "testDelay", value: { time: 7n } } });
    await new Promise((r) => setTimeout(r, 5));
    expect(net.log.some((m) => m.union.case === "testDelay" && m.union.value.time === 7n)).toBe(true);
    s.close();
  });
});

describe("FileTransferSession: download", () => {
  it("downloads a multi-block file with compressed and plain blocks", async () => {
    setup({ compress: "alternate" });
    const data = bytes(300 * 1024 + 17);
    fs.writeFile("/home/alice/big.bin", data, 1_700_000_500);
    const s = await connected();
    const progress: TransferProgress[] = [];
    s.on("progress", (p) => progress.push(p));
    const dl = s.download("/home/alice/big.bin");
    const files = [];
    for await (const f of dl) {
      expect(f).toMatchObject({ relativePath: "big.bin", remotePath: "/home/alice/big.bin", size: data.length, modified: 1_700_000_500_000 });
      files.push(await collect(f));
    }
    const result = await dl.done;
    expect(files).toHaveLength(1);
    expect(Buffer.compare(Buffer.from(files[0]!), Buffer.from(data))).toBe(0);
    expect(result).toMatchObject({ direction: "download", files: 1, skipped: 0, bytes: data.length });
    // blocks really were mixed
    const last = progress.at(-1)!;
    expect(last).toMatchObject({ bytes: data.length, totalBytes: data.length, files: 1, filesDone: 1 });
    const perFile = progress.filter((p) => p.file?.relativePath === "big.bin").map((p) => [p.file!.bytes, p.file!.size, p.filesDone]);
    expect(perFile[0]).toEqual([0, data.length, 0]);
    expect(perFile.at(-1)).toEqual([data.length, data.length, 1]);
    expect(fs.confirms).toEqual([`${dl.id}:0:0`]);
    s.close();
  });

  it("downloads a folder recursively and lets the consumer skip files", async () => {
    setup();
    fs.writeFile("/home/alice/docs/a.txt", "AAA");
    fs.writeFile("/home/alice/docs/sub/b.txt", "BBBB");
    fs.writeFile("/home/alice/docs/sub/empty.txt", "");
    fs.writeFile("/home/alice/docs/z.txt", "ZZ");
    const s = await connected();
    const dl = s.download("/home/alice/docs");
    const got: Record<string, string> = {};
    for await (const f of dl) {
      if (f.relativePath.endsWith("z.txt")) continue; // never read: skipped
      got[f.relativePath] = new TextDecoder().decode(await collect(f));
      expect(f.remotePath).toBe(`/home/alice/${f.relativePath}`);
    }
    const result = await dl.done;
    expect(got).toEqual({ "docs/a.txt": "AAA", "docs/sub/b.txt": "BBBB", "docs/sub/empty.txt": "" });
    expect(result).toMatchObject({ files: 3, skipped: 1, bytes: 7 });
    expect((await dl.files).map((f) => f.relativePath)).toEqual(["docs/a.txt", "docs/sub/b.txt", "docs/sub/empty.txt", "docs/z.txt"]);
    expect(fs.confirms).toEqual([`${dl.id}:0:0`, `${dl.id}:1:0`, `${dl.id}:2:0`, `${dl.id}:3:skip`]);
    s.close();
  });

  it("saves files through writable streams", async () => {
    setup();
    fs.writeFile("/home/alice/docs/a.txt", "one");
    fs.writeFile("/home/alice/docs/b.txt", "two");
    const s = await connected();
    const out: Record<string, string> = {};
    const result = await s.download("/home/alice/docs").saveTo((file) => {
      if (file.name === "b.txt") return null;
      let text = "";
      return new WritableStream<Uint8Array>({
        write: (c) => void (text += new TextDecoder().decode(c)),
        close: () => void (out[file.relativePath] = text),
      });
    });
    expect(out).toEqual({ "docs/a.txt": "one" });
    expect(result).toMatchObject({ files: 1, skipped: 1 });
    s.close();
  });

  it("collects a small file into a Blob and refuses folders", async () => {
    setup();
    fs.writeFile("/home/alice/hello.txt", "hello blob");
    fs.writeFile("/home/alice/docs/x.txt", "x");
    const s = await connected();
    const { file, blob } = await s.downloadBlob("/home/alice/hello.txt", { type: "text/plain" });
    expect(file.relativePath).toBe("hello.txt");
    expect(await blob.text()).toBe("hello blob");
    expect(blob.type).toBe("text/plain");
    await expect(s.downloadBlob("/home/alice/docs")).rejects.toMatchObject({ code: "not-a-file" });
    await expect(s.downloadBlob("/home/alice/hello.txt", { maxBytes: 4 })).rejects.toMatchObject({ code: "too-large" });
    // the session still works after those cancellations
    expect(await (await s.downloadBlob("/home/alice/hello.txt")).blob.text()).toBe("hello blob");
    s.close();
  });

  it("handles peers that send data without digests", async () => {
    setup({ noDigest: true, compress: "never" }, { peerInfo: { username: "alice", platform: "Linux", version: "1.1.9" } });
    fs.writeFile("/home/alice/docs/a.txt", "old");
    fs.writeFile("/home/alice/docs/b.txt", "peer");
    const s = await connected();
    const dl = s.download("/home/alice/docs");
    const got: string[] = [];
    for await (const f of dl) got.push(new TextDecoder().decode(await collect(f)));
    expect(got).toEqual(["old", "peer"]);
    expect(fs.confirms).toEqual([]);
    // uploads go straight to the data as well
    fs.writeFile("/home/alice/docs/c.txt", "overwritten without asking");
    await s.upload([new File(["new c"], "c.txt")], "/home/alice/docs").done;
    expect(fs.text("/home/alice/docs/c.txt")).toBe("new c");
    expect(net.log.some((m) => m.union.case === "fileResponse" && m.union.value.union.case === "digest")).toBe(false);
    s.close();
  });

  it("maps Windows paths of a folder download", async () => {
    setup(
      {},
      {
        peerInfo: { username: "bob", platform: "Windows", version: "1.4.3" },
        afterLogin: (peer) =>
          peer.send({ union: { case: "fileResponse", value: { union: { case: "dir", value: { id: 0, path: "C:\\Users\\bob" } } } } }),
        onMessage: (m, peer) => {
          if (m.union.case !== "fileAction") return;
          const a = m.union.value.union;
          const fr = (union: object) => peer.send({ union: { case: "fileResponse", value: { union } } } as never);
          if (a.case === "send") {
            fr({ case: "dir", value: { id: a.value.id, path: a.value.path, entries: [{ entryType: 4, name: "sub\\a.txt", size: 2n }] } });
            fr({ case: "digest", value: { id: a.value.id, fileNum: 0, fileSize: 2n } });
          } else if (a.case === "sendConfirm") {
            fr({ case: "block", value: { id: a.value.id, fileNum: 0, data: new Uint8Array([104, 105]) } });
            fr({ case: "block", value: { id: a.value.id, fileNum: 0 } });
            fr({ case: "done", value: { id: a.value.id, fileNum: 1 } });
          }
        },
      },
    );
    const s = await connected();
    const dl = s.download("C:\\Users\\bob\\docs");
    for await (const f of dl) {
      expect(f.relativePath).toBe("docs/sub/a.txt");
      expect(f.remotePath).toBe("C:\\Users\\bob\\docs\\sub\\a.txt");
      expect(new TextDecoder().decode(await collect(f))).toBe("hi");
    }
    expect(await dl.done).toMatchObject({ files: 1, bytes: 2 });
    s.close();
  });

  it("cancels a download mid-transfer", async () => {
    setup({ blockSize: 1024, blockDelay: 2, compress: "never" });
    fs.writeFile("/home/alice/slow.bin", bytes(64 * 1024));
    const s = await connected();
    const dl = s.download("/home/alice/slow.bin");
    let received = 0;
    const consumer = (async () => {
      for await (const f of dl) {
        for await (const c of f) {
          received += c.length;
          if (received >= 4096) dl.cancel();
        }
      }
    })();
    await expect(consumer).rejects.toMatchObject({ code: "cancelled" });
    await expect(dl.done).rejects.toBeInstanceOf(FileTransferError);
    expect(sent("cancel")).toEqual([{ $typeName: "rdweb.session.FileTransferCancel", id: dl.id }]);
    expect(fs.cancelled.has(dl.id)).toBe(true);
    expect(received).toBeLessThan(64 * 1024);
    // the next transfer runs
    fs.writeFile("/home/alice/small.txt", "ok");
    expect(await (await s.downloadBlob("/home/alice/small.txt")).blob.text()).toBe("ok");
    s.close();
  });

  it("cancels through an AbortSignal and when the loop is left early", async () => {
    setup({ blockSize: 1024, blockDelay: 1, compress: "never" });
    fs.writeFile("/home/alice/a.bin", bytes(32 * 1024));
    const s = await connected();
    const ac = new AbortController();
    const dl = s.download("/home/alice/a.bin", { signal: ac.signal });
    for await (const f of dl) {
      for await (const _ of f) {
        ac.abort();
        break;
      }
      break;
    }
    await expect(dl.done).rejects.toMatchObject({ code: "cancelled" });
    expect(fs.cancelled.has(dl.id)).toBe(true);
    s.close();
  });

  it("maps a peer error to a typed error and event", async () => {
    setup({ denied: ["/root"] });
    fs.writeFile("/root/x", "x");
    const s = await connected();
    const errors: FileErrorEvent[] = [];
    s.on("error", (e) => errors.push(e));
    const dl = s.download("/home/alice/missing.txt");
    await expect(dl.done).rejects.toMatchObject({ code: "not-found", jobId: dl.id });
    const dl2 = s.download("/root/x");
    await expect(dl2.done).rejects.toMatchObject({ code: "permission-denied", remoteMessage: "Permission denied (os error 13)" });
    expect(errors.map((e) => e.code)).toEqual(["not-found", "permission-denied"]);
    s.close();
  });

  it("rejects a zstd bomb", async () => {
    const bomb = new Uint8Array(zstdCompressSync(new Uint8Array(64 << 20)));
    setup({ tamper: (_f, blk, b) => (blk === 1 ? { data: bomb, compressed: true } : b) });
    fs.writeFile("/home/alice/f.bin", bytes(400 * 1024));
    const s = await connected();
    const errors: FileErrorEvent[] = [];
    s.on("error", (e) => errors.push(e));
    const dl = s.download("/home/alice/f.bin");
    const consumer = (async () => {
      for await (const f of dl) await collect(f);
    })();
    await expect(consumer).rejects.toMatchObject({ code: "decompress" });
    await expect(dl.done).rejects.toMatchObject({ code: "decompress", fileIndex: 0 });
    expect(errors[0]?.code).toBe("decompress");
    expect(fs.cancelled.has(dl.id)).toBe(true);
    s.close();
  });

  it("rejects an oversize block", async () => {
    setup({ compress: "never", tamper: (_f, blk, b) => (blk === 0 ? { data: new Uint8Array(70_000), compressed: false } : b) });
    fs.writeFile("/home/alice/f.bin", bytes(1000));
    const s = await connected({ maxBlockSize: 64 * 1024 });
    const dl = s.download("/home/alice/f.bin");
    const consumer = (async () => {
      for await (const f of dl) await collect(f);
    })();
    await expect(consumer).rejects.toMatchObject({ code: "oversize-block" });
    expect(fs.cancelled.has(dl.id)).toBe(true);
    s.close();
  });

  it("rejects file names that would leave the target folder", async () => {
    setup({ rename: (n) => (n === "a.txt" ? "../../etc/passwd" : n) });
    fs.writeFile("/home/alice/docs/a.txt", "x");
    const s = await connected();
    const dl = s.download("/home/alice/docs");
    await expect(dl.done).rejects.toMatchObject({ code: "invalid-name" });
    expect(fs.cancelled.has(dl.id)).toBe(true);
    s.close();
  });

  it("fails a slow consumer instead of buffering without bound", async () => {
    setup({ compress: "never", blockSize: 16 * 1024 });
    fs.writeFile("/home/alice/f.bin", bytes(256 * 1024));
    const s = await connected({ maxBufferedBytes: 64 * 1024 });
    const dl = s.download("/home/alice/f.bin");
    const it = dl[Symbol.asyncIterator]();
    const first = await it.next();
    const chunks = first.value![Symbol.asyncIterator]();
    await chunks.next(); // accept the file, then stop reading
    await expect(dl.done).rejects.toMatchObject({ code: "overflow" });
    s.close();
  });
});

describe("FileTransferSession: upload", () => {
  it("uploads files with an overwrite prompt and skip", async () => {
    setup();
    fs.writeFile("/home/alice/up/a.txt", "old a", 1_600_000_000);
    fs.writeFile("/home/alice/up/c.txt", "old c", 1_600_000_000);
    const s = await connected();
    const asked: string[] = [];
    s.on("conflict", ({ conflict, answer }) => {
      asked.push(`${conflict.file.relativePath}:${conflict.remote.size}:${conflict.identical}`);
      answer(conflict.file.relativePath === "a.txt" ? "overwrite" : "skip");
    });
    const progress: TransferProgress[] = [];
    const up = s.upload(
      [
        new File(["new a!"], "a.txt", { lastModified: 1_700_000_001_000 }),
        { name: "b.txt", relativePath: "sub/b.txt", data: new Blob(["bee"]), lastModified: 1_700_000_002_000 },
        new File(["new c"], "c.txt"),
      ],
      "/home/alice/up",
      { onProgress: (p) => progress.push(p) },
    );
    const result = await up.done;
    expect(asked).toEqual(["a.txt:5:false", "c.txt:5:false"]);
    expect(result).toMatchObject({ direction: "upload", files: 2, skipped: 1, bytes: 9 });
    expect(fs.text("/home/alice/up/a.txt")).toBe("new a!");
    expect(fs.text("/home/alice/up/sub/b.txt")).toBe("bee");
    expect(fs.text("/home/alice/up/c.txt")).toBe("old c");
    expect(fs.nodes.get("/home/alice/up/sub/b.txt")).toMatchObject({ mtime: 1_700_000_002 });
    const receive = sent("receive")[0] as { path: string; files: { name: string }[]; totalSize: bigint };
    expect(receive.path).toBe("/home/alice/up");
    expect(receive.files.map((f) => f.name)).toEqual(["a.txt", "sub/b.txt", "c.txt"]);
    expect(receive.totalSize).toBe(14n);
    expect(progress.at(-1)).toMatchObject({ bytes: 9, totalBytes: 9, filesDone: 2, skipped: 1 });
    s.close();
  });

  it("applies overwriteAll / a preset policy / skip without anyone to ask", async () => {
    setup();
    for (const n of ["a", "b", "c"]) fs.writeFile(`/home/alice/up/${n}.txt`, "old");
    const s = await connected();
    const files = () => ["a", "b", "c"].map((n) => new File([`new ${n}`], `${n}.txt`));
    let asked = 0;
    await s.upload(files(), "/home/alice/up", {
      onConflict: () => {
        asked++;
        return "overwriteAll";
      },
    }).done;
    expect(asked).toBe(1);
    expect(["a", "b", "c"].map((n) => fs.text(`/home/alice/up/${n}.txt`))).toEqual(["new a", "new b", "new c"]);

    const r = await s.upload([new File(["zzz"], "a.txt")], "/home/alice/up", { overwrite: "skip" }).done;
    expect(r).toMatchObject({ files: 0, skipped: 1 });
    expect(fs.text("/home/alice/up/a.txt")).toBe("new a");

    // no onConflict and no listener: existing files are kept
    const r2 = await s.upload([new File(["zzz"], "b.txt"), new File(["fresh"], "d.txt")], "/home/alice/up").done;
    expect(r2).toMatchObject({ files: 1, skipped: 1 });
    expect(fs.text("/home/alice/up/b.txt")).toBe("new b");
    expect(fs.text("/home/alice/up/d.txt")).toBe("fresh");
    s.close();
  });

  it("uploads a multi-block stream and an empty file", async () => {
    setup();
    const data = bytes(300 * 1024, 7);
    const s = await connected();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let off = 0; off < data.length; off += 50_000) c.enqueue(data.slice(off, off + 50_000));
        c.close();
      },
    });
    await s.upload(
      [
        { name: "big.bin", data: stream, size: data.length },
        { name: "empty.txt", data: new Blob([]) },
      ],
      "/home/alice/in",
    ).done;
    expect(Buffer.compare(Buffer.from(fs.file("/home/alice/in/big.bin")!), Buffer.from(data))).toBe(0);
    expect(fs.file("/home/alice/in/empty.txt")?.length).toBe(0);
    const blocks = net.log.filter((m) => m.union.case === "fileResponse" && m.union.value.union.case === "block");
    expect(blocks.every((m) => (m.union.value as { union: { value: { data: Uint8Array } } }).union.value.data.length <= 128 * 1024)).toBe(true);
    s.close();
  });

  it("respects the WebSocket send buffer", async () => {
    setup();
    const s = await connected({ sendBufferHighWater: 256 * 1024 });
    const sock = net.peer!.socket;
    sock.bufferedAmount = 10 << 20;
    const up = s.upload([new File([bytes(600 * 1024)], "x.bin")], "/home/alice");
    await new Promise((r) => setTimeout(r, 50));
    const blocks = () => net.log.filter((m) => m.union.case === "fileResponse" && m.union.value.union.case === "block").length;
    expect(blocks()).toBe(0);
    sock.bufferedAmount = 0;
    await up.done;
    expect(blocks()).toBe(6); // 5 data blocks + end of file
    s.close();
  });

  it("skips a single existing file and tells the peer so", async () => {
    setup();
    fs.writeFile("/home/alice/a.txt", "keep", 1_600_000_000);
    const s = await connected();
    const r = await s.upload([new File(["new"], "a.txt")], "/home/alice", { onConflict: () => "skip" }).done;
    expect(r).toMatchObject({ files: 0, skipped: 1 });
    expect(fs.text("/home/alice/a.txt")).toBe("keep");
    const errs = net.log.filter((m) => m.union.case === "fileResponse" && m.union.value.union.case === "error");
    expect(errs.map((m) => (m.union.value as { union: { value: { error: string } } }).union.value.error)).toEqual(["skipped"]);
    s.close();
  });

  it("resumes a partial upload", async () => {
    setup();
    const data = bytes(200 * 1024, 3);
    fs.partials.set("/home/alice/big.bin", { data: data.slice(0, 100 * 1024), size: data.length, mtime: 1_700_000_000 });
    fs.writeFile("/home/alice/big.bin", "something else");
    const s = await connected();
    const r = await s.upload([new File([data], "big.bin", { lastModified: 1_700_000_000_000 })], "/home/alice", { resume: true }).done;
    expect(Buffer.compare(Buffer.from(fs.file("/home/alice/big.bin")!), Buffer.from(data))).toBe(0);
    expect(r.bytes).toBe(data.length);
    const blockBytes = net.log
      .filter((m) => m.union.case === "fileResponse" && m.union.value.union.case === "block")
      .reduce((n, m) => n + (m.union.value as { union: { value: { data: Uint8Array } } }).union.value.data.length, 0);
    expect(blockBytes).toBe(100 * 1024);
    s.close();
  });

  it("cancels an upload mid-transfer", async () => {
    setup();
    const s = await connected();
    const blocks = () => net.log.filter((m) => m.union.case === "fileResponse" && m.union.value.union.case === "block").length;
    let sourceCancelled = false;
    let produced = 0;
    // a slow source: 64 KiB every few milliseconds
    const stream = new ReadableStream<Uint8Array>({
      async pull(c) {
        await new Promise((r) => setTimeout(r, 3));
        if (produced >= 1 << 20) return c.close();
        produced += 64 * 1024;
        c.enqueue(bytes(64 * 1024, produced));
      },
      cancel() {
        sourceCancelled = true;
      },
    });
    const up = s.upload([{ name: "big.bin", data: stream, size: 1 << 20 }], "/home/alice");
    while (blocks() < 2) await new Promise((r) => setTimeout(r, 2));
    up.cancel();
    await expect(up.done).rejects.toMatchObject({ code: "cancelled" });
    await new Promise((r) => setTimeout(r, 20));
    expect(fs.cancelled.has(up.id)).toBe(true);
    expect(sourceCancelled).toBe(true);
    expect(blocks()).toBeLessThan(8);
    expect(fs.file("/home/alice/big.bin")).toBeNull();
    s.close();
  });

  it("refuses unsafe upload names", async () => {
    setup();
    const s = await connected();
    expect(() => s.upload([{ name: "x", relativePath: "../x", data: new Blob(["x"]) }], "/home/alice")).toThrow(
      expect.objectContaining({ code: "invalid-name" }),
    );
    s.close();
  });
});

describe("FileTransferSession: file operations and permissions", () => {
  it("creates, renames and removes files and folders", async () => {
    setup({ denied: ["/etc"] });
    fs.writeFile("/home/alice/old.txt", "x");
    fs.writeFile("/home/alice/tree/a.txt", "a");
    fs.writeFile("/home/alice/tree/sub/b.txt", "b");
    fs.mkdirp("/home/alice/tree/empty");
    fs.mkdirp("/etc");
    const s = await connected();
    await s.mkdir("/home/alice/new/deep");
    expect(fs.nodes.get("/home/alice/new/deep")?.kind).toBe("dir");
    await s.rename("/home/alice/old.txt", "renamed.txt");
    expect(fs.text("/home/alice/renamed.txt")).toBe("x");
    await expect(s.rename("/home/alice/renamed.txt", "../evil")).rejects.toMatchObject({ code: "invalid-name" });
    await s.remove("/home/alice/renamed.txt");
    expect(fs.nodes.has("/home/alice/renamed.txt")).toBe(false);
    await expect(s.remove("/home/alice/tree", { dir: true })).rejects.toMatchObject({ code: "not-empty" });
    const steps: string[] = [];
    await s.remove("/home/alice/tree", { dir: true, recursive: true, onProgress: (n, t) => steps.push(`${n}/${t}`) });
    expect(steps).toEqual(["1/2", "2/2"]);
    expect([...fs.nodes.keys()].filter((p) => p.startsWith("/home/alice/tree"))).toEqual([]);
    await s.remove("/home/alice/new/deep", { dir: true });
    await expect(s.mkdir("/etc/x")).rejects.toMatchObject({ code: "permission-denied" });
    await expect(s.remove("/home/alice/none.txt")).rejects.toMatchObject({ code: "not-found" });
    s.close();
  });

  it("stops file work when the peer withdraws the file permission", async () => {
    setup({ blockSize: 1024, blockDelay: 2, compress: "never" });
    fs.writeFile("/home/alice/slow.bin", bytes(64 * 1024));
    const s = await connected();
    const events: string[] = [];
    s.on("permission", (p) => events.push(`${p.name}:${p.enabled}`));
    s.on("error", (e) => events.push(e.code));
    const dl = s.download("/home/alice/slow.bin");
    const consumer = (async () => {
      for await (const f of dl) await collect(f);
    })();
    await new Promise((r) => setTimeout(r, 10));
    net.peer!.send({
      union: { case: "misc", value: { union: { case: "permissionInfo", value: { permission: PermissionInfo_Permission.File, enabled: false } } } },
    });
    await expect(consumer).rejects.toMatchObject({ code: "permission-denied" });
    expect(events.slice(0, 2)).toEqual(["file:false", "permission-denied"]);
    expect(() => s.download("/home/alice/slow.bin")).toThrow(expect.objectContaining({ code: "permission-denied" }));
    await expect(s.listDir("")).rejects.toMatchObject({ code: "permission-denied" });
    expect(s.permission.file).toBe(false);
    s.close();
  });

  it("fails running jobs when the connection drops", async () => {
    setup({ blockSize: 1024, blockDelay: 2, compress: "never" });
    fs.writeFile("/home/alice/slow.bin", bytes(64 * 1024));
    const s = await connected();
    const closed = new Promise<{ remote: boolean }>((r) => s.on("close", r));
    const dl = s.download("/home/alice/slow.bin");
    const queued = s.download("/home/alice/slow.bin");
    const consumer = (async () => {
      for await (const f of dl) await collect(f);
    })();
    await new Promise((r) => setTimeout(r, 10));
    net.peer!.close();
    await expect(consumer).rejects.toMatchObject({ code: "closed" });
    await expect(queued.done).rejects.toMatchObject({ code: "closed" });
    expect((await closed).remote).toBe(true);
    expect(s.state).toBe("closed");
  });
});
