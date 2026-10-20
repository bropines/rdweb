// The file manager's local pane without React: listing and sorting a folder,
// upload items from a folder tree, path guards, downloads written into a
// folder (with conflicts), error mapping; and both directions against a
// FileTransferSession talking to the fake peer.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileTransferSession } from "../../src/files/session.js";
import type { ConflictAnswer } from "../../src/files/types.js";
import {
  collectUploadItems,
  compareNames,
  folderPermission,
  leaveDir,
  listLocalDir,
  localErrorKind,
  localSaver,
  localSegments,
  sortLocalEntries,
  stackPath,
  supportsLocalFolders,
  type LocalConflict,
} from "../../src/react/localFolder.js";
import { FakeFs } from "../fakefs.js";
import { FakeSocket, PASSWORD, PEER_ID, resetNet, serverConfig, sha256, SALT } from "../peer.js";
import { asDir, domError, FakeDirHandle, type FakeFileHandle } from "./fake-local-fs.js";

/* ── helpers ────────────────────────────────────────────────────────── */

describe("local folder helpers", () => {
  it("sorts folders first, in natural, case-insensitive order", () => {
    const names = ["file10.txt", "File2.txt", "b", "a", "file1.txt", "Zeta", "10", "9"];
    const kinds: Record<string, "file" | "directory"> = { b: "directory", Zeta: "directory", "10": "directory" };
    const sorted = sortLocalEntries(names.map((name) => ({ name, kind: kinds[name] ?? ("file" as const) })));
    expect(sorted.map((e) => e.name)).toEqual(["10", "b", "Zeta", "9", "a", "file1.txt", "File2.txt", "file10.txt"]);
    expect(compareNames("a", "A")).not.toBe(0); // stable for names that differ only in case
    expect(Math.sign(compareNames("x2", "x10"))).toBe(-1);
  });

  it("lists a folder with sizes and dates", async () => {
    const root = new FakeDirHandle("root");
    root.file("notes.txt", "hello", 1_700_000_123_000);
    root.dir("docs").file("a.txt", "a");
    const list = await listLocalDir(asDir(root));
    expect(list.map(({ name, kind, size, modified }) => ({ name, kind, size, modified }))).toEqual([
      { name: "docs", kind: "directory", size: 0, modified: 0 },
      { name: "notes.txt", kind: "file", size: 5, modified: 1_700_000_123_000 },
    ]);
  });

  it("builds upload items for files and whole folders", async () => {
    const root = new FakeDirHandle("root");
    const photos = root.dir("photos");
    photos.file("b10.jpg", "bbbb", 1_700_000_001_000);
    photos.file("b2.jpg", "bb");
    photos.dir("2024").file("x.png", "xx");
    photos.dir("empty");
    const top = root.file("top.txt", "top");
    const items = await collectUploadItems([{ handle: asDir(photos) }, { handle: top as unknown as FileSystemFileHandle }]);
    expect(items.map((i) => [i.relativePath, i.name, i.size])).toEqual([
      ["photos/2024/x.png", "x.png", 2],
      ["photos/b2.jpg", "b2.jpg", 2],
      ["photos/b10.jpg", "b10.jpg", 4],
      ["top.txt", "top.txt", 3],
    ]);
    expect(items[2]!.lastModified).toBe(1_700_000_001_000);
    expect(await (items[3]!.data as Blob).text()).toBe("top");
  });

  it("keeps paths and navigation inside the picked folder", () => {
    expect(localSegments("docs/sub/a.txt")).toEqual(["docs", "sub", "a.txt"]);
    for (const bad of ["", "/etc/passwd", "a/../../b", "..", "./a", "a//b", "a\\b", "a\0b", "a/"]) {
      expect(() => localSegments(bad), bad).toThrowError(expect.objectContaining({ code: "invalid-name" }));
    }
    const a = asDir(new FakeDirHandle("picked"));
    const b = asDir(new FakeDirHandle("sub"));
    expect(leaveDir([a, b])).toEqual([a]);
    expect(leaveDir([a])).toEqual([a]);
    expect(leaveDir([])).toEqual([]);
    expect(stackPath([a, b])).toBe("picked/sub");
  });

  it("maps File System Access errors", () => {
    expect(localErrorKind(domError("NotAllowedError"))).toBe("denied");
    expect(localErrorKind(domError("SecurityError"))).toBe("denied");
    expect(localErrorKind(domError("NotFoundError"))).toBe("gone");
    expect(localErrorKind(domError("QuotaExceededError"))).toBe("noSpace");
    expect(localErrorKind(domError("TypeMismatchError"))).toBe("typeMismatch");
    expect(localErrorKind(new Error("boom"))).toBeNull();
    expect(localErrorKind(null)).toBeNull();
  });

  it("detects the API and asks for permission only when told to", async () => {
    expect(supportsLocalFolders({})).toBe(false);
    expect(supportsLocalFolders({ showDirectoryPicker: () => {} })).toBe(true);
    expect(supportsLocalFolders(undefined)).toBe(false);
    const h = {
      kind: "directory",
      name: "x",
      queryPermission: vi.fn(async () => "prompt" as PermissionState),
      requestPermission: vi.fn(async () => "granted" as PermissionState),
    } as unknown as FileSystemHandle;
    expect(await folderPermission(h)).toBe("prompt");
    expect(await folderPermission(h, true)).toBe("granted");
    expect((h as unknown as { queryPermission: { mock: { calls: unknown[][] } } }).queryPermission.mock.calls).toEqual([[{ mode: "readwrite" }]]);
    // browsers without the permission methods: the handle is usable as it is
    expect(await folderPermission({ kind: "directory", name: "y" } as unknown as FileSystemHandle)).toBe("granted");
  });
});

describe("localSaver", () => {
  const write = async (open: ReturnType<typeof localSaver>, relativePath: string, text: string) => {
    const data = new TextEncoder().encode(text);
    const sink = await open({ relativePath, size: data.length, modified: 0 });
    if (!sink) return false;
    const w = sink.getWriter();
    await w.write(data);
    await w.close();
    return true;
  };

  it("creates folders, asks before replacing and remembers 'all' answers", async () => {
    const root = new FakeDirHandle("dl");
    root.dir("docs").file("a.txt", "old a");
    root.dir("docs").file("b.txt", "old b");
    root.dir("docs").file("c.txt", "old c");
    root.file("d.txt", "old d");
    const asked: LocalConflict[] = [];
    const answers: ConflictAnswer[] = ["skip", "overwriteAll"];
    const open = localSaver(asDir(root), (c) => (asked.push(c), answers.shift()!));

    expect(await write(open, "docs/new/n.txt", "new")).toBe(true);
    expect(await write(open, "docs/a.txt", "new a")).toBe(false); // skip
    expect(await write(open, "docs/b.txt", "new b!")).toBe(true); // overwriteAll
    expect(await write(open, "docs/c.txt", "new c")).toBe(true); // remembered
    expect(await write(open, "d.txt", "new d")).toBe(true);

    expect((root.at("docs/new/n.txt") as FakeFileHandle).text).toBe("new");
    expect((root.at("docs/a.txt") as FakeFileHandle).text).toBe("old a");
    expect((root.at("docs/b.txt") as FakeFileHandle).text).toBe("new b!");
    expect((root.at("docs/c.txt") as FakeFileHandle).text).toBe("new c");
    expect((root.at("d.txt") as FakeFileHandle).text).toBe("new d");
    expect(asked.map((c) => [c.relativePath, c.existing.size, c.incoming.size])).toEqual([
      ["docs/a.txt", 5, 5],
      ["docs/b.txt", 5, 6],
    ]);

    // skipAll sticks as well
    const ask = vi.fn((): ConflictAnswer => "skipAll");
    const open2 = localSaver(asDir(root), ask);
    expect(await write(open2, "docs/a.txt", "x")).toBe(false);
    expect(await write(open2, "docs/b.txt", "x")).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("refuses unsafe paths and reports a folder in the way", async () => {
    const root = new FakeDirHandle("dl");
    root.dir("taken");
    const open = localSaver(asDir(root), () => "overwrite");
    await expect(open({ relativePath: "../evil.txt", size: 1, modified: 0 })).rejects.toMatchObject({ code: "invalid-name" });
    await expect(open({ relativePath: "taken", size: 1, modified: 0 })).rejects.toMatchObject({ name: "TypeMismatchError" });
    expect(root.children.size).toBe(1);
  });
});

/* ── against a file transfer session ────────────────────────────────── */

describe("local pane transfers", () => {
  let fs: FakeFs;

  beforeEach(() => {
    vi.stubGlobal("WebSocket", FakeSocket);
    fs = new FakeFs({ compress: "alternate" });
    resetNet({
      afterLogin: (peer) =>
        fs.handle({ union: { case: "fileAction", value: { union: { case: "readDir", value: { path: "", includeHidden: false } } } } } as never, peer),
      onMessage: (m, peer) => fs.handle(m, peer),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const connect = async () => {
    const s = new FileTransferSession({ peerId: PEER_ID, server: serverConfig(), rememberedHash: sha256(PASSWORD, SALT), requestTimeoutMs: 2000 });
    await s.connect();
    return s;
  };

  it("downloads a remote folder into the local folder, asking before replacing", async () => {
    fs.writeFile("/home/alice/docs/a.txt", "remote a");
    fs.writeFile("/home/alice/docs/sub/b.txt", "remote b");
    fs.writeFile("/home/alice/notes.txt", "notes");
    const s = await connect();
    const root = new FakeDirHandle("Downloads");
    root.dir("docs").file("a.txt", "local a");
    const asked: string[] = [];
    const save = localSaver(asDir(root), (c) => (asked.push(c.relativePath), "skip"));
    const results = await Promise.all([s.download("/home/alice/docs").saveTo(save), s.download("/home/alice/notes.txt").saveTo(save)]);
    expect(results.map((r) => [r.files, r.skipped])).toEqual([
      [1, 1],
      [1, 0],
    ]);
    expect(asked).toEqual(["docs/a.txt"]);
    expect((root.at("docs/a.txt") as FakeFileHandle).text).toBe("local a");
    expect((root.at("docs/sub/b.txt") as FakeFileHandle).text).toBe("remote b");
    expect((root.at("notes.txt") as FakeFileHandle).text).toBe("notes");
    s.close();
  });

  it("uploads local files and folders into a remote folder", async () => {
    const s = await connect();
    const root = new FakeDirHandle("Desktop");
    const project = root.dir("project");
    project.file("readme.md", "# hi");
    project.dir("src").file("main.ts", "export {};");
    const single = root.file("todo.txt", "buy milk");
    const items = await collectUploadItems([{ handle: asDir(project) }, { handle: single as unknown as FileSystemFileHandle }]);
    const r = await s.upload(items, "/home/alice/in").done;
    expect(r).toMatchObject({ files: 3, skipped: 0 });
    expect(fs.text("/home/alice/in/project/readme.md")).toBe("# hi");
    expect(fs.text("/home/alice/in/project/src/main.ts")).toBe("export {};");
    expect(fs.text("/home/alice/in/todo.txt")).toBe("buy milk");
    s.close();
  });
});
