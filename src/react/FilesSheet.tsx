import {
  ArrowUp,
  ChevronLeft,
  Download as DownloadIcon,
  EllipsisVertical,
  Eye,
  EyeOff,
  File as FileIcon,
  Folder,
  FolderDown,
  FolderPlus,
  FolderUp,
  HardDrive,
  House,
  Laptop,
  LoaderCircle,
  Monitor,
  PanelLeft,
  Pencil,
  RefreshCw,
  Trash2,
  Upload as UploadIcon,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  FileTransferError,
  FileTransferSession,
  type ConflictAnswer,
  type FilePeerSummary,
  type RemoteEntry,
  type ServerConfig,
  type TransferProgress,
  type UploadConflict,
  type UploadItem,
} from "../index.js";

import { formatSize } from "./format.js";
import { useI18n } from "./i18n/index.js";
import { cn } from "./lib/utils.js";
import { DRAG_TYPE, LocalPane, useLocalFolder } from "./LocalPane.js";
import {
  collectUploadItems,
  compareNames,
  loadLocalPanePref,
  localErrorKind,
  localSaver,
  saveLocalPanePref,
  supportsLocalFolders,
  type LocalConflict,
  type LocalEntry,
} from "./localFolder.js";
import { DEFAULT_STORAGE_KEY } from "./prefs.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu.js";
import { Input } from "./ui/input.js";
import { Checkbox } from "./ui/misc.js";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./ui/sheet.js";
import { ZipWriter } from "./zip.js";

export interface FilesSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  peerId: string;
  server: ServerConfig;
  /** Salted password hash of the remote-desktop login, so the files connection signs in silently. */
  rememberedHash: Uint8Array | null;
  myName?: string;
  myId?: string;
  /** Full-page file manager (no remote desktop) instead of a side sheet. */
  inline?: boolean;
  /** Inline mode: shown as a back button in the header. */
  onBack?: () => void;
  /** Inline mode: device name or id in the header. */
  title?: string;
  /** The file transfer connection is up. */
  onConnected?(peer: FilePeerSummary): void;
  /** Files to upload into the current folder once connected (pasted or dropped on the screen). */
  incoming?: UploadItem[] | null;
  onIncomingDone?: () => void;
  /**
   * Prefix for what the file manager remembers in this browser: whether the
   * local pane is shown (localStorage) and its folder (IndexedDB). Default "rdweb".
   */
  storageKey?: string;
}

/** The sheet, or a full-page container in inline mode. */
function Shell({ inline, open, onOpenChange, children }: { inline?: boolean; open: boolean; onOpenChange: (o: boolean) => void; children: React.ReactNode }) {
  return inline ? <>{children}</> : <Sheet open={open} onOpenChange={onOpenChange}>{children}</Sheet>;
}

function Panel({ inline, wide, closeLabel, children }: { inline?: boolean; wide?: boolean; closeLabel: string; children: React.ReactNode }) {
  return inline ? (
    <div className="flex h-dvh min-h-0 flex-col bg-background text-foreground">{children}</div>
  ) : (
    <SheetContent className={cn("sm:max-w-2xl", wide && "md:max-w-5xl")} closeLabel={closeLabel}>
      {children}
    </SheetContent>
  );
}

export type ConnState = "idle" | "connecting" | "password" | "twoFactor" | "waiting" | "ready" | "error";

interface Transfer {
  id: number;
  label: string;
  direction: "download" | "upload";
  progress: TransferProgress | null;
  state: "running" | "done" | "failed" | "cancelled";
  message?: string;
  cancel: () => void;
}

type ShowDirectoryPicker = (o?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;

function isDir(e: RemoteEntry): boolean {
  return e.type === "dir" || e.type === "dirLink" || e.type === "drive";
}

/** Folders first, then natural order (like the local pane). */
function sortRemote(list: RemoteEntry[]): RemoteEntry[] {
  return [...list].sort((a, b) => Number(isDir(b)) - Number(isDir(a)) || compareNames(a.name, b.name));
}

/** What is being dragged between the panes. */
type PaneDrag = { from: "local"; items: LocalEntry[] } | { from: "remote"; items: RemoteEntry[] };

/** An upload conflict (asked by the session) or a download that would replace a local file. */
type Conflict = { answer: (a: ConflictAnswer) => void } & ({ c: UploadConflict; local?: undefined } | { c?: undefined; local: LocalConflict });

function saveBlob(blob: Blob, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}

/** Files from a drop, including folders (via the entries API where available). */
/** Files (and folders, where the browser exposes entries) of a drop or paste. */
export async function droppedItems(dt: DataTransfer): Promise<UploadItem[]> {
  const out: UploadItem[] = [];
  const entries = [...dt.items]
    .map((i) => (typeof i.webkitGetAsEntry === "function" ? i.webkitGetAsEntry() : null))
    .filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) {
    for (const f of [...dt.files]) out.push({ name: f.name, size: f.size, lastModified: f.lastModified, data: f });
    return out;
  }
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ name: file.name, relativePath: prefix + file.name, size: file.size, lastModified: file.lastModified, data: file });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const e of entries) await walk(e, "");
  return out;
}

export function FilesSheet(p: FilesSheetProps) {
  const { t, lang } = useI18n();
  const ftRef = useRef<FileTransferSession | null>(null);
  const [conn, setConn] = useState<ConnState>("idle");
  const [attempt, setAttempt] = useState(0);
  const [connError, setConnError] = useState("");
  const [pwWrong, setPwWrong] = useState(false);
  const [secret, setSecret] = useState("");
  const [cwd, setCwd] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [nameDialog, setNameDialog] = useState<{ kind: "mkdir" | "rename"; entry?: RemoteEntry } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<RemoteEntry[] | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const isWindows = ftRef.current?.peer?.os === "windows";
  const storageKey = p.storageKey ?? DEFAULT_STORAGE_KEY;
  // The local pane needs the File System Access API (Chromium); elsewhere it does not exist.
  const [localSupported] = useState(() => supportsLocalFolders());
  const [localOn, setLocalOn] = useState(() => localSupported && loadLocalPanePref(storageKey));
  /** Narrow screens show one pane at a time. */
  const [tab, setTab] = useState<"local" | "remote">("remote");
  const drag = useRef<PaneDrag | null>(null);

  const fail = useCallback(
    (e: unknown) => {
      const code = e instanceof FileTransferError ? e.code : "";
      const known = ["not-found", "permission-denied", "exists", "not-empty", "invalid-name", "overflow", "too-large", "timeout"];
      const localKind = code ? null : localErrorKind(e);
      toast.error(code && known.includes(code) ? t(`files.errors.${code}`) : localKind ? t(`files.local.errors.${localKind}`) : (e as Error).message);
    },
    [t],
  );
  const local = useLocalFolder(storageKey, localOn, fail);

  const list = useCallback(
    async (path: string, hidden = showHidden) => {
      const ft = ftRef.current;
      if (!ft) return;
      setLoading(true);
      try {
        const dir = await ft.listDir(path, { showHidden: hidden });
        setCwd(dir.path);
        setPathInput(dir.path);
        setEntries(sortRemote(dir.entries));
        setSelected(new Set());
      } catch (e) {
        fail(e);
      } finally {
        setLoading(false);
      }
    },
    [fail, showHidden],
  );

  // Connect lazily on first open; keep the connection while the remote session lives.
  useEffect(() => {
    if (!p.open || ftRef.current) return;
    const ft = new FileTransferSession({
      peerId: p.peerId,
      server: p.server,
      rememberedHash: p.rememberedHash ?? undefined,
      myName: p.myName,
      myId: p.myId,
    });
    ftRef.current = ft;
    setConn("connecting");
    ft.on("password", ({ wrong }) => {
      setPwWrong(wrong);
      setConn("password");
    });
    ft.on("twoFactor", ({ wrong }) => {
      setPwWrong(wrong);
      setConn("twoFactor");
    });
    ft.on("waitingForApproval", () => setConn("waiting"));
    ft.on("connected", ({ home }) => {
      setConn("ready");
      const peer = ft.peer;
      if (peer) p.onConnected?.(peer);
      if (home) {
        setCwd(home.path);
        setPathInput(home.path);
        setEntries(sortRemote(home.entries));
      }
    });
    ft.on("conflict", ({ conflict: c, answer }) => setConflict({ c, answer }));
    ft.on("close", ({ reason }) => {
      setConn((s) => (s === "ready" ? "error" : s === "idle" ? s : "error"));
      setConnError(reason);
      ftRef.current = null;
    });
    ft.connect().catch((e: Error) => {
      setConnError(e instanceof FileTransferError && e.code === "permission-denied" ? t("files.errors.permission-denied") : e.message);
      setConn("error");
    });
  }, [p.open, p.peerId, p.server, p.rememberedHash, p.myName, p.myId, t, attempt]);

  useEffect(
    () => () => {
      ftRef.current?.close("closed");
      ftRef.current = null;
    },
    [],
  );

  const upsertTransfer = (tr: Partial<Transfer> & { id: number }) =>
    setTransfers((list) => {
      const i = list.findIndex((x) => x.id === tr.id);
      if (i < 0) return [tr as Transfer, ...list].slice(0, 30);
      const next = [...list];
      next[i] = { ...next[i]!, ...tr };
      return next;
    });

  const track = (job: { id: number; done: Promise<unknown>; cancel: () => void }, label: string, direction: "download" | "upload", after?: () => void) => {
    upsertTransfer({ id: job.id, label, direction, progress: null, state: "running", cancel: job.cancel });
    job.done.then(
      () => {
        upsertTransfer({ id: job.id, state: "done" });
        after?.();
      },
      (e: unknown) => {
        const cancelled = e instanceof FileTransferError && e.code === "cancelled";
        upsertTransfer({ id: job.id, state: cancelled ? "cancelled" : "failed", message: cancelled ? undefined : (e as Error).message });
        if (!cancelled) fail(e);
      },
    );
  };

  const onProgress = (pr: TransferProgress) => upsertTransfer({ id: pr.jobId, progress: pr });

  const download = async (items: RemoteEntry[]) => {
    const ft = ftRef.current;
    if (!ft || !items.length) return;
    const picker = (window as unknown as { showDirectoryPicker?: ShowDirectoryPicker }).showDirectoryPicker;
    const needsFolder = items.length > 1 || items.some(isDir);
    if (needsFolder && picker) {
      let target: FileSystemDirectoryHandle;
      try {
        target = await picker({ mode: "readwrite" });
      } catch {
        return; // picker cancelled
      }
      for (const e of items) {
        const job = ft.download(ft.joinPath(cwd, e.name), { showHidden, onProgress });
        track(job, e.name, "download");
        void job
          .saveTo(async (file) => {
            const parts = file.relativePath.split("/").filter(Boolean);
            let d = target;
            for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part, { create: true });
            const fh = await d.getFileHandle(parts.at(-1) ?? file.name, { create: true });
            return fh.createWritable();
          })
          .catch(() => {});
      }
      return;
    }
    if (!needsFolder) {
      const e = items[0]!;
      const job = ft.download(ft.joinPath(cwd, e.name), { onProgress });
      track(job, e.name, "download");
      try {
        for await (const file of job) {
          const blob = await file.blob(4 * 1024 ** 3);
          saveBlob(blob, e.name);
        }
      } catch {
        /* reported by track() */
      }
      return;
    }
    // No folder picker (Safari, Firefox): one zip archive.
    const zip = new ZipWriter();
    const archive = items.length === 1 ? `${items[0]!.name}.zip` : `${p.peerId}-files.zip`;
    let failed = false;
    for (const e of items) {
      const job = ft.download(ft.joinPath(cwd, e.name), { showHidden, onProgress });
      track(job, e.name, "download");
      try {
        for await (const file of job) await zip.add(file.relativePath, file.modified, file);
        await job.done;
      } catch (err) {
        failed = true;
        job.cancel();
        if (!(err instanceof FileTransferError)) fail(err);
        break;
      }
    }
    if (!failed) saveBlob(zip.finish(), archive);
  };

  const upload = (items: UploadItem[], label?: string) => {
    const ft = ftRef.current;
    if (!ft || !items.length) return;
    label ??= items.length === 1 ? (items[0]!.relativePath ?? items[0]!.name) : t("files.nFiles", { count: items.length });
    const job = ft.upload(items, cwd, { onProgress });
    track(job, label, "upload", () => void list(cwd));
  };

  /** Local pane → the remote folder that is open. */
  const uploadLocal = async (items: LocalEntry[]) => {
    if (!ftRef.current || !items.length) return;
    try {
      upload(await collectUploadItems(items), items.length === 1 ? items[0]!.name : undefined);
    } catch (e) {
      fail(e);
    }
  };

  /** Remote entries → the local pane's open folder, asking before replacing files. */
  const downloadToLocal = (items: RemoteEntry[]) => {
    const ft = ftRef.current;
    const target = local.cwd;
    if (!ft || !target || !items.length) return;
    const save = localSaver(target, (c) => new Promise<ConflictAnswer>((answer) => setConflict({ local: c, answer })));
    const runs = items.map((e) => {
      const job = ft.download(ft.joinPath(cwd, e.name), { showHidden, onProgress });
      // saveTo also fails with the local side's errors (no space, access revoked)
      const done = job.saveTo(save);
      track({ id: job.id, done, cancel: () => job.cancel() }, e.name, "download");
      return done;
    });
    void Promise.allSettled(runs).then(() => local.refresh());
  };

  // Files pasted or dropped on the remote screen: upload when the connection is up.
  useEffect(() => {
    if (conn !== "ready" || !p.incoming?.length) return;
    upload(p.incoming);
    p.onIncomingDone?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, p.incoming]);

  const fromInput = (files: FileList | null) => {
    if (!files) return;
    upload(
      [...files].map((f) => ({
        name: f.name,
        relativePath: f.webkitRelativePath || f.name,
        size: f.size,
        lastModified: f.lastModified,
        data: f,
      })),
    );
  };

  const remove = async (items: RemoteEntry[]) => {
    const ft = ftRef.current;
    if (!ft) return;
    for (const e of items) {
      try {
        await ft.remove(ft.joinPath(cwd, e.name), { dir: isDir(e), recursive: true });
      } catch (err) {
        fail(err);
        break;
      }
    }
    void list(cwd);
  };

  const selectedEntries = useMemo(() => entries.filter((e) => selected.has(e.name)), [entries, selected]);
  const ready = conn === "ready";
  const visibleEntries = entries;
  // the local pane is part of a connected file manager (the password prompt stays visible on phones)
  const split = localOn && ready;
  const toLocal = split && !!local.cwd;

  const toggleLocal = () => {
    const on = !localOn;
    setLocalOn(on);
    saveLocalPanePref(storageKey, on);
    setTab(on ? "local" : "remote");
  };

  const dragRemote = (ev: React.DragEvent, e: RemoteEntry) => {
    const items = selected.has(e.name) ? selectedEntries : [e];
    ev.dataTransfer.effectAllowed = "copy";
    ev.dataTransfer.setData(DRAG_TYPE, items.map((i) => i.name).join("\n"));
    drag.current = { from: "remote", items };
  };

  return (
    <Shell inline={p.inline} open={p.open} onOpenChange={p.onOpenChange}>
      <Panel inline={p.inline} wide={split} closeLabel={t("common.close")}>
        {p.inline ? (
          <div className="flex items-center gap-2 border-b px-3 py-3">
            {p.onBack && (
              <Button size="icon" variant="ghost" aria-label={t("toolbar.back")} title={t("toolbar.back")} onClick={p.onBack}>
                <ChevronLeft className="h-5 w-5" />
              </Button>
            )}
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold">
                {t("files.title")}
                {p.title ? ` · ${p.title}` : ""}
              </h1>
              <p className="truncate text-xs text-muted-foreground">{ready ? cwd || "/" : t(`files.state.${conn}`)}</p>
            </div>
          </div>
        ) : (
          <SheetHeader>
            <SheetTitle>{t("files.title")}</SheetTitle>
            <SheetDescription className="truncate text-xs">{ready ? cwd || "/" : t(`files.state.${conn}`)}</SheetDescription>
          </SheetHeader>
        )}

        {split && (
          <div role="tablist" className="flex border-b md:hidden">
            {(["local", "remote"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={tab === k}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 border-b-2 px-3 py-2 text-sm",
                  tab === k ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setTab(k)}
              >
                {k === "local" ? <Laptop className="h-4 w-4" /> : <Monitor className="h-4 w-4" />}
                {t(k === "local" ? "files.local.title" : "files.local.remote")}
              </button>
            ))}
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {split && (
            <LocalPane
              local={local}
              canTransfer={ready}
              split
              className={cn("md:border-r", tab !== "local" && "hidden md:flex")}
              onUpload={(items) => void uploadLocal(items)}
              onDragRows={(items) => (drag.current = items ? { from: "local", items } : null)}
              acceptsDrop={() => drag.current?.from === "remote"}
              onDrop={() => {
                const d = drag.current;
                drag.current = null;
                if (d?.from === "remote") downloadToLocal(d.items);
              }}
            />
          )}
          <section
            className={cn("flex min-h-0 min-w-0 flex-1 flex-col", split && tab !== "remote" && "hidden md:flex")}
            aria-label={split ? t("files.local.remote") : undefined}
          >
            {ready && (
              <div className="flex flex-wrap items-center gap-1 border-b px-3 py-2">
                <Button variant="ghost" size="icon" className="h-8 w-8" title={t("files.up")} aria-label={t("files.up")} onClick={() => void list(ftRef.current!.parentPath(cwd))}>
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8" title={t("files.home")} aria-label={t("files.home")} onClick={() => void list("")}>
                  <House className="h-4 w-4" />
                </Button>
                {isWindows && (
                  <Button variant="ghost" size="icon" className="h-8 w-8" title={t("files.drives")} aria-label={t("files.drives")} onClick={() => void list("/")}>
                    <HardDrive className="h-4 w-4" />
                  </Button>
                )}
                <form
                  className="min-w-0 flex-1 basis-40"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void list(pathInput.trim());
                  }}
                >
                  <Input value={pathInput} onChange={(e) => setPathInput(e.target.value)} className="h-8 font-mono text-xs" aria-label={t("files.path")} />
                </form>
                <Button variant="ghost" size="icon" className="h-8 w-8" title={t("common.refresh")} aria-label={t("common.refresh")} onClick={() => void list(cwd)}>
                  <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  title={t("files.showHidden")}
                  aria-label={t("files.showHidden")}
                  aria-pressed={showHidden}
                  onClick={() => {
                    setShowHidden(!showHidden);
                    void list(cwd, !showHidden);
                  }}
                >
                  {showHidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8" title={t("files.newFolder")} aria-label={t("files.newFolder")} onClick={() => setNameDialog({ kind: "mkdir" })}>
                  <FolderPlus className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8" title={t("files.uploadFiles")} aria-label={t("files.uploadFiles")} onClick={() => fileInput.current?.click()}>
                  <UploadIcon className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8" title={t("files.uploadFolder")} aria-label={t("files.uploadFolder")} onClick={() => folderInput.current?.click()}>
                  <FolderUp className="h-4 w-4" />
                </Button>
                {localSupported && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn("h-8 w-8", localOn && "bg-accent text-accent-foreground")}
                    title={t("files.local.toggle")}
                    aria-label={t("files.local.toggle")}
                    aria-pressed={localOn}
                    onClick={toggleLocal}
                  >
                    <PanelLeft className="h-4 w-4" />
                  </Button>
                )}
                <input ref={fileInput} type="file" multiple hidden onChange={(e) => (fromInput(e.target.files), (e.target.value = ""))} />
                <input
                  ref={folderInput}
                  type="file"
                  hidden
                  {...({ webkitdirectory: "" } as Record<string, string>)}
                  onChange={(e) => (fromInput(e.target.files), (e.target.value = ""))}
                />
              </div>
            )}

            {ready && selectedEntries.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-1.5 text-sm">
                <span className="flex-1">{t("files.selected", { count: selectedEntries.length })}</span>
                {toLocal && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      downloadToLocal(selectedEntries);
                      setSelected(new Set());
                    }}
                  >
                    <FolderDown className="mr-1.5 h-4 w-4" />
                    {t("files.local.download")}
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={() => void download(selectedEntries)}>
                  <DownloadIcon className="mr-1.5 h-4 w-4" />
                  {t("files.download")}
                </Button>
                <Button size="sm" variant="outline" className="text-destructive" onClick={() => setConfirmDelete(selectedEntries)}>
                  <Trash2 className="mr-1.5 h-4 w-4" />
                  {t("common.delete")}
                </Button>
              </div>
            )}

            <SheetBody
              className={cn("p-0", dragOver && "bg-primary/5 ring-2 ring-inset ring-primary")}
              onDragOver={(e) => {
                if (!ready || drag.current?.from === "remote") return;
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                if (!ready) return;
                e.preventDefault();
                setDragOver(false);
                const d = drag.current;
                drag.current = null;
                if (d?.from === "local") void uploadLocal(d.items);
                else if (!d) void droppedItems(e.dataTransfer).then(upload, fail);
              }}
            >
              {!ready && (
                <ConnectPane
                  state={conn}
                  error={connError}
                  wrong={pwWrong}
                  secret={secret}
                  setSecret={setSecret}
                  onSubmit={() => {
                    const ft = ftRef.current;
                    if (!ft || !secret) return;
                    if (conn === "twoFactor") ft.submitTwoFactor(secret);
                    else void ft.login(secret);
                    setSecret("");
                    setConn("connecting");
                  }}
                  onRetry={() => {
                    ftRef.current?.close("closed");
                    ftRef.current = null;
                    setConn("idle");
                    setConnError("");
                    setAttempt((a) => a + 1);
                  }}
                />
              )}
              {ready && (
                <ul className="divide-y" aria-busy={loading}>
                  {visibleEntries.length === 0 && <li className="px-4 py-8 text-center text-sm text-muted-foreground">{t("files.empty")}</li>}
                  {visibleEntries.map((e) => (
                    <li
                      key={e.name}
                      className={cn("flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/50", e.hidden && "opacity-60")}
                      draggable={toLocal && e.type !== "drive"}
                      onDragStart={(ev) => dragRemote(ev, e)}
                      onDragEnd={() => (drag.current = null)}
                    >
                      {e.type !== "drive" && (
                        <Checkbox
                          checked={selected.has(e.name)}
                          onCheckedChange={(v) =>
                            setSelected((s) => {
                              const n = new Set(s);
                              if (v === true) n.add(e.name);
                              else n.delete(e.name);
                              return n;
                            })
                          }
                          aria-label={e.name}
                        />
                      )}
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        onClick={() => (isDir(e) ? void list(ftRef.current!.joinPath(cwd, e.name)) : void download([e]))}
                        title={isDir(e) ? e.name : t("files.download")}
                      >
                        {e.type === "drive" ? (
                          <HardDrive className="h-4 w-4 shrink-0 text-muted-foreground" />
                        ) : isDir(e) ? (
                          <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                        ) : (
                          <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                        )}
                        <span className="min-w-0 flex-1 truncate">{e.name}</span>
                      </button>
                      <span className="hidden w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:inline">{isDir(e) ? "" : formatSize(e.size, lang)}</span>
                      <span className={cn("hidden w-32 shrink-0 text-right text-xs tabular-nums text-muted-foreground", split ? "lg:inline" : "md:inline")}>
                        {e.modified ? new Date(e.modified).toLocaleString(lang, { dateStyle: "short", timeStyle: "short" }) : ""}
                      </span>
                      {e.type !== "drive" && (
                        <DropdownMenu modal={false}>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label={t("common.more")}>
                              <EllipsisVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => void download([e])}>
                              <DownloadIcon className="mr-2 h-4 w-4" />
                              {t("files.download")}
                            </DropdownMenuItem>
                            {toLocal && (
                              <DropdownMenuItem onSelect={() => downloadToLocal([e])}>
                                <FolderDown className="mr-2 h-4 w-4" />
                                {t("files.local.download")}
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem onSelect={() => setNameDialog({ kind: "rename", entry: e })}>
                              <Pencil className="mr-2 h-4 w-4" />
                              {t("files.rename")}
                            </DropdownMenuItem>
                            <DropdownMenuItem className="text-destructive" onSelect={() => setConfirmDelete([e])}>
                              <Trash2 className="mr-2 h-4 w-4" />
                              {t("common.delete")}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </SheetBody>
          </section>
        </div>

        {transfers.length > 0 && (
          <div className="max-h-48 overflow-y-auto border-t px-3 py-2">
            <div className="mb-1 flex items-center justify-between text-xs font-medium text-muted-foreground">
              <span>{t("files.transfers")}</span>
              <button type="button" className="hover:underline" onClick={() => setTransfers((l) => l.filter((x) => x.state === "running"))}>
                {t("files.clearFinished")}
              </button>
            </div>
            <ul className="space-y-1.5">
              {transfers.map((tr) => {
                const pr = tr.progress;
                const pct = pr && pr.totalBytes > 0 ? Math.min(100, Math.round((pr.bytes / pr.totalBytes) * 100)) : tr.state === "done" ? 100 : 0;
                return (
                  <li key={tr.id} className="text-xs">
                    <div className="flex items-center gap-2">
                      {tr.direction === "download" ? <DownloadIcon className="h-3.5 w-3.5 shrink-0" /> : <UploadIcon className="h-3.5 w-3.5 shrink-0" />}
                      <span className="min-w-0 flex-1 truncate">{tr.label}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {tr.state === "running"
                          ? pr
                            ? `${formatSize(pr.bytes, lang)} / ${formatSize(pr.totalBytes, lang)}${pr.files > 1 ? ` · ${pr.filesDone}/${pr.files}` : ""}`
                            : "…"
                          : t(`files.status.${tr.state}`)}
                      </span>
                      {tr.state === "running" && (
                        <button type="button" className="shrink-0 text-muted-foreground hover:text-foreground" aria-label={t("common.cancel")} onClick={tr.cancel}>
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                    <div className="mt-0.5 h-1 overflow-hidden rounded bg-muted">
                      <div className={cn("h-full transition-all", tr.state === "failed" ? "bg-destructive" : "bg-primary")} style={{ width: `${pct}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </Panel>

      <NameDialog
        state={nameDialog}
        onClose={() => setNameDialog(null)}
        onSubmit={async (name) => {
          const ft = ftRef.current;
          const d = nameDialog;
          setNameDialog(null);
          if (!ft || !d) return;
          try {
            if (d.kind === "mkdir") await ft.mkdir(ft.joinPath(cwd, name));
            else if (d.entry) await ft.rename(ft.joinPath(cwd, d.entry.name), name);
          } catch (e) {
            fail(e);
          }
          void list(cwd);
        }}
      />
      <Dialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md" closeLabel={t("common.close")}>
          <DialogHeader>
            <DialogTitle>{t("files.deleteTitle", { count: confirmDelete?.length ?? 0 })}</DialogTitle>
            <DialogDescription className="break-all">{confirmDelete?.map((e) => e.name).join(", ")}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const items = confirmDelete ?? [];
                setConfirmDelete(null);
                void remove(items);
              }}
            >
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!conflict} onOpenChange={(o) => !o && conflict && (conflict.answer("skip"), setConflict(null))}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md" closeLabel={t("common.close")}>
          <DialogHeader>
            <DialogTitle>{t("files.conflictTitle")}</DialogTitle>
            <DialogDescription className="break-all">
              {conflict?.c &&
                t("files.conflictDesc", {
                  name: conflict.c.file.relativePath,
                  remote: formatSize(conflict.c.remote.size, lang),
                  local: formatSize(conflict.c.file.size, lang),
                })}
              {conflict?.local &&
                t("files.local.conflictDesc", {
                  name: conflict.local.relativePath,
                  local: formatSize(conflict.local.existing.size, lang),
                  remote: formatSize(conflict.local.incoming.size, lang),
                })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-wrap gap-2">
            {(["skip", "skipAll", "overwrite", "overwriteAll"] as ConflictAnswer[]).map((a) => (
              <Button
                key={a}
                variant={a.startsWith("overwrite") ? "default" : "outline"}
                onClick={() => {
                  conflict?.answer(a);
                  setConflict(null);
                }}
              >
                {t(`files.conflict.${a}`)}
              </Button>
            ))}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}

export function ConnectPane({
  state,
  error,
  wrong,
  secret,
  setSecret,
  onSubmit,
  onRetry,
  passwordDesc,
  connectingText,
}: {
  state: ConnState;
  error: string;
  wrong: boolean;
  secret: string;
  setSecret: (v: string) => void;
  onSubmit: () => void;
  onRetry: () => void;
  passwordDesc?: string;
  connectingText?: string;
}) {
  const { t } = useI18n();
  if (state === "password" || state === "twoFactor" || state === "waiting") {
    return (
      <form
        className="mx-auto max-w-sm space-y-3 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <p className="text-sm text-muted-foreground">
          {state === "twoFactor" ? t("twoFactorDesc") : state === "waiting" ? t("waitingForApproval") : (passwordDesc ?? t("files.passwordDesc"))}
        </p>
        {wrong && <p className="text-sm text-destructive">{state === "twoFactor" ? t("twoFactorWrong") : t("wrongPassword")}</p>}
        <Input
          type={state === "twoFactor" ? "text" : "password"}
          inputMode={state === "twoFactor" ? "numeric" : undefined}
          autoComplete={state === "twoFactor" ? "one-time-code" : "off"}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          aria-label={state === "twoFactor" ? t("twoFactorTitle") : t("passwordPlaceholder")}
          placeholder={state === "twoFactor" ? "123456" : t("passwordPlaceholder")}
          autoFocus
        />
        <Button type="submit" className="w-full" disabled={!secret}>
          {state === "twoFactor" ? t("verify") : t("connect")}
        </Button>
      </form>
    );
  }
  if (state === "error") {
    return (
      <div className="space-y-3 p-6 text-center">
        <p className="text-sm text-destructive">{error || t("files.state.error")}</p>
        <Button variant="outline" onClick={onRetry}>
          <RefreshCw className="mr-2 h-4 w-4" />
          {t("reconnect")}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground">
      <LoaderCircle className="h-4 w-4 animate-spin" />
      {connectingText ?? t("files.state.connecting")}
    </div>
  );
}

function NameDialog({
  state,
  onClose,
  onSubmit,
}: {
  state: { kind: "mkdir" | "rename"; entry?: RemoteEntry } | null;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  useEffect(() => setName(state?.entry?.name ?? ""), [state]);
  const bad = !name.trim() || /[\\/]/.test(name) || name === "." || name === "..";
  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-sm" closeLabel={t("common.close")}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!bad) onSubmit(name.trim());
          }}
        >
          <DialogHeader>
            <DialogTitle>{state?.kind === "mkdir" ? t("files.newFolder") : t("files.rename")}</DialogTitle>
            <DialogDescription className="sr-only">{t("files.nameHint")}</DialogDescription>
          </DialogHeader>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus aria-label={t("files.name")} />
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={bad}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
