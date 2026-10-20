// The file manager's "My computer" pane: a folder on this computer opened with
// the File System Access API (Chromium only), listed, uploaded from and
// downloaded into. These are the parts without React; the pane itself is in
// LocalPane.tsx.
//
// Storage: whether the pane is shown lives in localStorage under
// `<storageKey>.files.localPane`; the picked folder handle (which cannot be
// serialised to JSON) in IndexedDB, database "rdweb-files", key
// `<storageKey>.files.localFolder`.

import { FileTransferError, type ConflictAnswer, type UploadItem } from "../index.js";

export interface LocalEntry {
  name: string;
  kind: "file" | "directory";
  /** Bytes (0 for folders). */
  size: number;
  /** Milliseconds since the epoch; 0 for folders and unreadable files. */
  modified: number;
  handle: FileSystemFileHandle | FileSystemDirectoryHandle;
}

/** The async iteration and permission parts of the API that TypeScript's DOM lib leaves out. */
type DirHandle = FileSystemDirectoryHandle & {
  values(): AsyncIterable<FileSystemFileHandle | FileSystemDirectoryHandle>;
};
type PermissionHandle = FileSystemHandle & {
  queryPermission?(d: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(d: { mode: "read" | "readwrite" }): Promise<PermissionState>;
};
type ShowDirectoryPicker = (o?: { id?: string; mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;

/** The browser can open local folders read-write (Chrome, Edge, Opera; not Safari or Firefox). */
export function supportsLocalFolders(w: object | undefined = typeof window === "undefined" ? undefined : window): boolean {
  return !!w && "showDirectoryPicker" in w;
}

/** Asks the user for a folder (rejects with an AbortError if they cancel). */
export function pickLocalFolder(): Promise<FileSystemDirectoryHandle> {
  return (window as unknown as { showDirectoryPicker: ShowDirectoryPicker }).showDirectoryPicker({ id: "rdweb-local", mode: "readwrite" });
}

/* ── sorting and listing ─────────────────────────────────────────────── */

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Natural order ("file2" before "file10"), case-insensitive, stable for names that differ only in case. */
export function compareNames(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Folders first, then natural order by name. */
export function sortLocalEntries<T extends { name: string; kind: "file" | "directory" }>(list: T[]): T[] {
  return [...list].sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || compareNames(a.name, b.name));
}

async function children(dir: FileSystemDirectoryHandle): Promise<(FileSystemFileHandle | FileSystemDirectoryHandle)[]> {
  const out: (FileSystemFileHandle | FileSystemDirectoryHandle)[] = [];
  for await (const h of (dir as DirHandle).values()) out.push(h);
  return out;
}

/** The folder's entries with sizes and dates, sorted like the remote list. */
export async function listLocalDir(dir: FileSystemDirectoryHandle): Promise<LocalEntry[]> {
  const handles = await children(dir);
  const entries = await Promise.all(
    handles.map(async (h): Promise<LocalEntry> => {
      if (h.kind === "directory") return { name: h.name, kind: "directory", size: 0, modified: 0, handle: h };
      try {
        const f = await (h as FileSystemFileHandle).getFile();
        return { name: h.name, kind: "file", size: f.size, modified: f.lastModified, handle: h };
      } catch {
        // locked or vanished since the listing: still show it
        return { name: h.name, kind: "file", size: 0, modified: 0, handle: h };
      }
    }),
  );
  return sortLocalEntries(entries);
}

/**
 * Upload items for local files and folders: folders are walked recursively
 * and their files get "/"-separated relative paths starting with the folder's
 * name ("photos/2024/a.jpg"), the way a folder upload from an input does.
 * Empty folders have no files and are not created remotely.
 */
export async function collectUploadItems(entries: { handle: FileSystemFileHandle | FileSystemDirectoryHandle }[]): Promise<UploadItem[]> {
  const out: UploadItem[] = [];
  const walk = async (h: FileSystemFileHandle | FileSystemDirectoryHandle, path: string): Promise<void> => {
    if (h.kind === "file") {
      const f = await (h as FileSystemFileHandle).getFile();
      out.push({ name: h.name, relativePath: path, size: f.size, lastModified: f.lastModified, data: f });
      return;
    }
    const list = (await children(h as FileSystemDirectoryHandle)).sort((a, b) => compareNames(a.name, b.name));
    for (const c of list) await walk(c, `${path}/${c.name}`);
  };
  for (const e of entries) await walk(e.handle, e.handle.name);
  return out;
}

/* ── navigation and paths ────────────────────────────────────────────── */

/** The open folder is the last handle; the first is the folder the user picked. */
export type FolderStack = readonly FileSystemDirectoryHandle[];

/** One level up, but never above the picked folder. */
export function leaveDir(stack: FolderStack): FolderStack {
  return stack.length > 1 ? stack.slice(0, -1) : stack;
}

/** "picked/sub/sub" for the header. */
export function stackPath(stack: FolderStack): string {
  return stack.map((d) => d.name).join("/");
}

/**
 * Segments of a "/"-separated path below a local folder. Anything that could
 * leave the folder or is not a plain name (empty, ".", "..", backslashes,
 * NUL, a leading "/") is refused with an "invalid-name" error.
 */
export function localSegments(relativePath: string): string[] {
  const parts = relativePath.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".." || /[\\\0]/.test(p))) {
    throw new FileTransferError(`not a safe local path: ${JSON.stringify(relativePath)}`, "invalid-name");
  }
  return parts;
}

/* ── downloads into the folder ───────────────────────────────────────── */

export interface LocalConflict {
  /** Below the target folder, "/"-separated. */
  relativePath: string;
  /** The file already in the local folder. */
  existing: { size: number; modified: number };
  /** The file being downloaded. */
  incoming: { size: number; modified: number };
}

async function existingFile(dir: FileSystemDirectoryHandle, name: string): Promise<File | null> {
  let fh: FileSystemFileHandle;
  try {
    fh = await dir.getFileHandle(name);
  } catch (e) {
    if ((e as { name?: string } | null)?.name === "NotFoundError") return null;
    throw e; // TypeMismatchError: a folder of that name is in the way
  }
  return fh.getFile();
}

/**
 * An opener for `Download.saveTo` that writes each file below `root`,
 * creating its folders. A file that already exists is offered to `ask`;
 * "overwriteAll" / "skipAll" stick for the rest of the files this opener
 * writes (share one opener between the jobs of one action).
 */
export function localSaver(
  root: FileSystemDirectoryHandle,
  ask: (c: LocalConflict) => ConflictAnswer | Promise<ConflictAnswer>,
): (file: { relativePath: string; size: number; modified: number }) => Promise<WritableStream<Uint8Array> | null> {
  let remembered: "overwrite" | "skip" | null = null;
  return async (file) => {
    const parts = localSegments(file.relativePath);
    let dir = root;
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
    const name = parts[parts.length - 1]!;
    const existing = await existingFile(dir, name);
    if (existing) {
      let answer: ConflictAnswer =
        remembered ??
        (await ask({
          relativePath: file.relativePath,
          existing: { size: existing.size, modified: existing.lastModified },
          incoming: { size: file.size, modified: file.modified },
        }));
      if (answer === "overwriteAll" || answer === "skipAll") {
        answer = answer === "overwriteAll" ? "overwrite" : "skip";
        remembered = answer;
      }
      if (answer === "skip") return null;
    }
    const fh = await dir.getFileHandle(name, { create: true });
    return (await fh.createWritable()) as WritableStream<Uint8Array>;
  };
}

/* ── errors and permissions ──────────────────────────────────────────── */

export type LocalErrorKind = "denied" | "gone" | "noSpace" | "typeMismatch";

/** What went wrong with a File System Access call, for a translated message (null: something else). */
export function localErrorKind(e: unknown): LocalErrorKind | null {
  switch ((e as { name?: string } | null)?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "denied";
    case "NotFoundError":
      return "gone";
    case "QuotaExceededError":
      return "noSpace";
    case "TypeMismatchError":
      return "typeMismatch";
    default:
      return null;
  }
}

/**
 * Read-write permission for a stored folder. `request` asks the user and
 * must run in a click handler; without it the state is only queried.
 */
export async function folderPermission(h: FileSystemHandle, request = false): Promise<PermissionState> {
  const ph = h as PermissionHandle;
  const fn = request ? ph.requestPermission : ph.queryPermission;
  if (typeof fn !== "function") return "granted";
  return fn.call(ph, { mode: "readwrite" });
}

/* ── storage ─────────────────────────────────────────────────────────── */

const paneKey = (storageKey: string) => `${storageKey}.files.localPane`;
const folderKey = (storageKey: string) => `${storageKey}.files.localFolder`;
const DB = "rdweb-files";
const STORE = "handles";

export function loadLocalPanePref(storageKey: string): boolean {
  try {
    return localStorage.getItem(paneKey(storageKey)) === "1";
  } catch {
    return false;
  }
}

export function saveLocalPanePref(storageKey: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(paneKey(storageKey), "1");
    else localStorage.removeItem(paneKey(storageKey));
  } catch {
    /* storage unavailable */
  }
}

function withStore(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<unknown> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    let open: IDBOpenDBRequest;
    try {
      open = indexedDB.open(DB, 1);
    } catch {
      resolve(null);
      return;
    }
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => resolve(null);
    open.onblocked = () => resolve(null);
    open.onsuccess = () => {
      const db = open.result;
      try {
        const req = fn(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result as unknown);
        req.onerror = () => resolve(null);
        req.transaction?.addEventListener("complete", () => db.close());
        req.transaction?.addEventListener("abort", () => db.close());
      } catch {
        db.close();
        resolve(null);
      }
    };
  });
}

/** The folder picked earlier with this storage key, if the browser kept it. */
export async function loadLocalFolder(storageKey: string): Promise<FileSystemDirectoryHandle | null> {
  const v = await withStore("readonly", (s) => s.get(folderKey(storageKey)));
  const h = v as Partial<FileSystemDirectoryHandle> | null;
  return h && typeof h === "object" && h.kind === "directory" && typeof h.getDirectoryHandle === "function" ? (h as FileSystemDirectoryHandle) : null;
}

/** Remembers (or with null forgets) the picked folder. */
export async function saveLocalFolder(storageKey: string, dir: FileSystemDirectoryHandle | null): Promise<void> {
  await withStore("readwrite", (s) => (dir ? s.put(dir, folderKey(storageKey)) : s.delete(folderKey(storageKey))));
}

/** Forgets the pane preference and the picked folder (part of clearStoredData). */
export function clearLocalFolderData(storageKey: string): void {
  saveLocalPanePref(storageKey, false);
  void saveLocalFolder(storageKey, null);
}
