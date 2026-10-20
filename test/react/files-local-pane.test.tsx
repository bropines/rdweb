// @vitest-environment jsdom
// The file manager's local pane in the UI: hidden without the File System
// Access API, toggled and remembered, a picked folder listed, and transfers
// in both directions wired to the file transfer session.
import "./setup-dom.js";

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RemoteEntry, UploadItem } from "../../src/index.js";
import { asDir, domError, FakeDirHandle, type FakeFileHandle } from "./fake-local-fs.js";

const fakes = vi.hoisted(() => {
  type Handler = (payload: unknown) => void;
  type Opener = (f: { relativePath: string; size: number; modified: number }) => Promise<WritableStream<Uint8Array> | null>;
  class FakeFileTransfer {
    static all: FakeFileTransfer[] = [];
    handlers = new Map<string, Set<Handler>>();
    peer = { os: "linux" };
    home: RemoteEntry[] = [
      { name: "docs", type: "dir", size: 0, modified: 0, hidden: false },
      { name: "report.txt", type: "file", size: 6, modified: 0, hidden: false },
    ];
    uploads: { items: UploadItem[]; dir: string }[] = [];
    downloads: string[] = [];
    constructor(public opts: unknown) {
      FakeFileTransfer.all.push(this);
    }
    on(ev: string, fn: Handler) {
      if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
      this.handlers.get(ev)!.add(fn);
      return () => this.handlers.get(ev)!.delete(fn);
    }
    emit(ev: string, payload: unknown = {}) {
      for (const fn of this.handlers.get(ev) ?? []) fn(payload);
    }
    connect = vi.fn(async () => this.emit("connected", { peer: this.peer, rememberedHash: null, home: { path: "/home/alice", entries: this.home } }));
    close = vi.fn();
    joinPath = (dir: string, name: string) => `${dir}/${name}`;
    parentPath = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
    listDir = vi.fn(async (path: string) => ({ path, entries: this.home }));
    upload = vi.fn((items: UploadItem[], dir: string) => {
      this.uploads.push({ items, dir });
      return { id: 1, done: Promise.resolve({}), cancel: vi.fn() };
    });
    download = vi.fn((path: string) => {
      this.downloads.push(path);
      const name = path.slice(path.lastIndexOf("/") + 1);
      return {
        id: 2,
        done: Promise.resolve({}),
        cancel: vi.fn(),
        saveTo: async (open: Opener) => {
          const sink = await open({ relativePath: name, size: 6, modified: 0 });
          if (sink) {
            const w = sink.getWriter();
            await w.write(new TextEncoder().encode("remote"));
            await w.close();
          }
          return {};
        },
      };
    });
  }
  return { FakeFileTransfer };
});

// IndexedDB stand-in for the remembered folder
const stored = vi.hoisted(() => ({ handle: null as unknown, saves: [] as unknown[] }));
vi.mock("../../src/react/localFolder.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/react/localFolder.js")>()),
  loadLocalFolder: async () => stored.handle,
  saveLocalFolder: async (_key: string, h: unknown) => {
    stored.saves.push(h);
    stored.handle = h;
  },
}));

vi.mock("../../src/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/index.js")>()),
  FileTransferSession: fakes.FakeFileTransfer,
}));

const { FilesSheet } = await import("../../src/react/FilesSheet.js");
const { I18nProvider } = await import("../../src/react/i18n/index.js");

const server = { rendezvousUrl: "wss://rd.example.com/ws/id", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" };
const ft = () => fakes.FakeFileTransfer.all.at(-1)!;
const win = window as unknown as { showDirectoryPicker?: unknown };

async function renderFiles(storageKey?: string) {
  render(
    <I18nProvider lang="en">
      <FilesSheet inline open onOpenChange={() => {}} peerId="123456789" server={server} rememberedHash={null} storageKey={storageKey} />
    </I18nProvider>,
  );
  // connect() resolves in a microtask
  await act(async () => {});
  expect(screen.getByRole("button", { name: "report.txt" })).toBeTruthy();
}

beforeEach(() => {
  localStorage.clear();
  fakes.FakeFileTransfer.all = [];
  stored.handle = null;
  stored.saves = [];
});
afterEach(() => {
  cleanup();
  delete win.showDirectoryPicker;
});

describe("FilesSheet local pane", () => {
  it("does not exist without the File System Access API", async () => {
    localStorage.setItem("rdweb.files.localPane", "1");
    await renderFiles();
    expect(screen.getByRole("button", { name: "Upload files" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Local folder" })).toBeNull();
    expect(screen.queryByText("My computer")).toBeNull();
  });

  it("toggles the pane and remembers it under the storage key", async () => {
    win.showDirectoryPicker = vi.fn();
    await renderFiles("host");
    const toggle = screen.getByRole("button", { name: "Local folder" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("host.files.localPane")).toBe("1");
    const pane = screen.getByRole("region", { name: "My computer" });
    // no stored folder (no IndexedDB here): offer the picker
    await act(async () => {});
    expect(within(pane).getByText(/Choose a folder on this computer/)).toBeTruthy();
    // narrow screens switch between the panes with tabs
    expect(screen.getByRole("tab", { name: "My computer" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Device" })).toBeTruthy();

    fireEvent.click(toggle);
    expect(screen.queryByRole("region", { name: "My computer" })).toBeNull();
    expect(localStorage.getItem("host.files.localPane")).toBeNull();
  });

  it("lists a picked folder and transfers in both directions", async () => {
    const root = new FakeDirHandle("Desktop");
    root.file("notes.txt", "my notes");
    root.dir("photos").file("a.jpg", "jpg");
    root.file("report.txt", "old local report");
    win.showDirectoryPicker = vi.fn(async () => asDir(root));
    localStorage.setItem("rdweb.files.localPane", "1");
    await renderFiles();
    const pane = screen.getByRole("region", { name: "My computer" });
    await act(async () => {});
    await act(async () => fireEvent.click(within(pane).getAllByRole("button", { name: "Choose folder" }).at(-1)!));
    expect(win.showDirectoryPicker).toHaveBeenCalledWith({ id: "rdweb-local", mode: "readwrite" });
    expect(within(pane).getByText("Desktop")).toBeTruthy();
    expect(within(pane).getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"))).toEqual(["photos", "notes.txt", "report.txt"]);

    // local → remote: a folder and a file into the open remote folder
    fireEvent.click(within(pane).getByRole("checkbox", { name: "photos" }));
    fireEvent.click(within(pane).getByRole("checkbox", { name: "notes.txt" }));
    await act(async () => fireEvent.click(within(pane).getByRole("button", { name: "Upload to remote" })));
    expect(ft().uploads).toHaveLength(1);
    expect(ft().uploads[0]!.dir).toBe("/home/alice");
    expect(ft().uploads[0]!.items.map((i) => i.relativePath)).toEqual(["photos/a.jpg", "notes.txt"]);

    // remote → local: asks before replacing report.txt
    const device = screen.getByRole("region", { name: "Device" });
    fireEvent.click(within(device).getByRole("checkbox", { name: "report.txt" }));
    await act(async () => fireEvent.click(within(device).getByRole("button", { name: "Download to local folder" })));
    expect(ft().downloads).toEqual(["/home/alice/report.txt"]);
    const dialog = screen.getByRole("dialog", { name: "File already exists" });
    expect(within(dialog).getByText(/report\.txt already exists in the local folder/)).toBeTruthy();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Replace" })));
    expect((root.at("report.txt") as FakeFileHandle).text).toBe("remote");
  });

  it("asks again for a remembered folder, from a click", async () => {
    const root = new FakeDirHandle("Projects");
    root.file("plan.md", "x");
    const perm = Object.assign(root, {
      queryPermission: vi.fn(async () => "prompt"),
      requestPermission: vi.fn(async () => "granted"),
    });
    stored.handle = perm;
    win.showDirectoryPicker = vi.fn();
    localStorage.setItem("rdweb.files.localPane", "1");
    await renderFiles();
    const pane = screen.getByRole("region", { name: "My computer" });
    await act(async () => {});
    expect(within(pane).getByText("Allow access to “Projects” again to keep working with it.")).toBeTruthy();
    expect(perm.requestPermission).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(within(pane).getByRole("button", { name: "Reconnect folder" })));
    expect(perm.requestPermission).toHaveBeenCalledWith({ mode: "readwrite" });
    expect(within(pane).getByRole("checkbox", { name: "plan.md" })).toBeTruthy();
  });

  it("explains a folder that is gone and offers the picker again", async () => {
    const root = new FakeDirHandle("Old");
    root.values = async function* () {
      throw domError("NotFoundError");
    };
    stored.handle = root;
    win.showDirectoryPicker = vi.fn();
    localStorage.setItem("rdweb.files.localPane", "1");
    await renderFiles();
    const pane = screen.getByRole("region", { name: "My computer" });
    await act(async () => {});
    expect(within(pane).getByText(/no longer available/)).toBeTruthy();
    expect(within(pane).getAllByRole("button", { name: "Choose folder" }).length).toBe(2);
    expect(stored.saves).toEqual([null]);
  });
});
