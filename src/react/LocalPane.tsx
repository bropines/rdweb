import { ArrowUp, File as FileIcon, Folder, FolderOpen, Laptop, LoaderCircle, RefreshCw, Upload as UploadIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { formatSize } from "./format.js";
import { useI18n } from "./i18n/index.js";
import { cn } from "./lib/utils.js";
import {
  folderPermission,
  leaveDir,
  listLocalDir,
  loadLocalFolder,
  localErrorKind,
  pickLocalFolder,
  saveLocalFolder,
  stackPath,
  type FolderStack,
  type LocalEntry,
} from "./localFolder.js";
import { Button } from "./ui/button.js";
import { Checkbox } from "./ui/misc.js";

/** Drag data type of rows dragged between the panes. */
export const DRAG_TYPE = "application/x-rdweb-files";

/**
 * idle: not looked at yet; none: no folder picked; prompt: a stored folder
 * needs the user's permission again; denied: access refused or revoked;
 * gone: the folder was moved or deleted; failed: it could not be listed for
 * another reason (reported through onError).
 */
export type LocalStatus = "idle" | "loading" | "none" | "prompt" | "denied" | "gone" | "failed" | "ready";

export interface LocalFolder {
  status: LocalStatus;
  stack: FolderStack;
  /** The open folder (null until one is open). */
  cwd: FileSystemDirectoryHandle | null;
  entries: LocalEntry[];
  busy: boolean;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  /** Shows the folder picker (call from a click). */
  choose(): Promise<void>;
  /** Asks again for access to the stored folder (call from a click). */
  reconnect(): Promise<void>;
  enter(e: LocalEntry): void;
  up(): void;
  /** Lists the open folder again, keeping the selection. */
  refresh(): Promise<void>;
}

/**
 * State of the local pane: the stored folder is loaded (and its permission
 * queried) the first time `enabled` is true. Listing failures that mean the
 * folder is gone or no longer accessible switch the status; anything else
 * goes to `onError`.
 */
export function useLocalFolder(storageKey: string, enabled: boolean, onError: (e: unknown) => void): LocalFolder {
  const [status, setStatus] = useState<LocalStatus>("idle");
  const [stack, setStackState] = useState<FolderStack>([]);
  const stackRef = useRef<FolderStack>([]);
  const [entries, setEntries] = useState<LocalEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const seq = useRef(0);
  const started = useRef(false);
  const errRef = useRef(onError);
  errRef.current = onError;

  const setStack = (s: FolderStack) => {
    stackRef.current = s;
    setStackState(s);
  };

  const show = useCallback(
    async (next: FolderStack, keepSelection = false): Promise<void> => {
      const dir = next[next.length - 1];
      if (!dir) return;
      const n = ++seq.current;
      setBusy(true);
      try {
        const list = await listLocalDir(dir);
        if (n !== seq.current) return;
        setStack(next);
        setEntries(list);
        setStatus("ready");
        setSelected((s) => (keepSelection ? new Set(list.filter((e) => s.has(e.name)).map((e) => e.name)) : new Set()));
      } catch (e) {
        if (n !== seq.current) return;
        const kind = localErrorKind(e);
        if (kind === "gone" && next.length > 1) {
          // a subfolder vanished: back to its parent
          errRef.current(e);
          await show(leaveDir(next));
        } else if (kind === "gone") {
          setStack([]);
          setEntries([]);
          setStatus("gone");
          void saveLocalFolder(storageKey, null);
        } else if (kind === "denied") {
          setStack(next.slice(0, 1));
          setEntries([]);
          setStatus("denied");
        } else {
          errRef.current(e);
          // keep a listing that is already shown; otherwise there is nothing to show
          setStatus((s) => (s === "ready" ? s : "failed"));
        }
      } finally {
        if (n === seq.current) setBusy(false);
      }
    },
    [storageKey],
  );

  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;
    setStatus("loading");
    void (async () => {
      const h = await loadLocalFolder(storageKey).catch(() => null);
      if (!h) {
        setStatus("none");
        return;
      }
      setStack([h]);
      let p: PermissionState;
      try {
        p = await folderPermission(h);
      } catch {
        p = "prompt";
      }
      // requestPermission needs a click: until then offer "Reconnect folder"
      if (p === "granted") await show([h]);
      else setStatus(p === "denied" ? "denied" : "prompt");
    })();
  }, [enabled, storageKey, show]);

  const choose = useCallback(async () => {
    let h: FileSystemDirectoryHandle;
    try {
      h = await pickLocalFolder();
    } catch (e) {
      if ((e as { name?: string } | null)?.name !== "AbortError") errRef.current(e);
      return;
    }
    void saveLocalFolder(storageKey, h);
    await show([h]);
  }, [show, storageKey]);

  const reconnect = useCallback(async () => {
    const root = stackRef.current[0];
    if (!root) return choose();
    let p: PermissionState;
    try {
      p = await folderPermission(root, true);
    } catch {
      p = "denied";
    }
    if (p === "granted") await show([root]);
    else setStatus("denied");
  }, [choose, show]);

  return {
    status,
    stack,
    cwd: status === "ready" ? (stack[stack.length - 1] ?? null) : null,
    entries,
    busy,
    selected,
    setSelected,
    choose,
    reconnect,
    enter: (e) => {
      if (e.kind === "directory") void show([...stackRef.current, e.handle as FileSystemDirectoryHandle]);
    },
    up: () => {
      if (stackRef.current.length > 1) void show(leaveDir(stackRef.current));
    },
    refresh: () => show(stackRef.current, true),
  };
}

export interface LocalPaneProps {
  local: LocalFolder;
  /** The remote side is connected (uploads possible, rows draggable). */
  canTransfer: boolean;
  onUpload: (entries: LocalEntry[]) => void;
  /** Rows started (entries) or stopped (null) being dragged. */
  onDragRows: (entries: LocalEntry[] | null) => void;
  /** Remote rows are being dragged over the pane. */
  acceptsDrop: () => boolean;
  onDrop: () => void;
  /** Two panes side by side: dates only on large screens. */
  split?: boolean;
  className?: string;
}

/** The "My computer" pane: a local folder, its entries, selection and drop target. */
export function LocalPane({ local, canTransfer, onUpload, onDragRows, acceptsDrop, onDrop, split, className }: LocalPaneProps) {
  const { t, lang } = useI18n();
  const [over, setOver] = useState(false);
  const { status, entries, selected, setSelected } = local;
  const selectedEntries = useMemo(() => entries.filter((e) => selected.has(e.name)), [entries, selected]);
  const path = stackPath(local.stack);
  const ready = status === "ready";

  const toggle = (name: string, on: boolean) => {
    const n = new Set(selected);
    if (on) n.add(name);
    else n.delete(name);
    setSelected(n);
  };

  return (
    <section className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)} aria-label={t("files.local.title")}>
      <div className="flex items-center gap-1 border-b px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          title={t("files.up")}
          aria-label={t("files.up")}
          disabled={!ready || local.stack.length <= 1}
          onClick={local.up}
        >
          <ArrowUp className="h-4 w-4" />
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 px-1 text-xs" title={path || undefined}>
          <Laptop className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className={cn("truncate", path && "font-mono")}>{path || t("files.local.title")}</span>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8" title={t("common.refresh")} aria-label={t("common.refresh")} disabled={!ready} onClick={() => void local.refresh()}>
          <RefreshCw className={cn("h-4 w-4", local.busy && "animate-spin")} />
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" title={t("files.local.choose")} aria-label={t("files.local.choose")} onClick={() => void local.choose()}>
          <FolderOpen className="h-4 w-4" />
        </Button>
      </div>

      {ready && selectedEntries.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-1.5 text-sm">
          <span className="flex-1">{t("files.selected", { count: selectedEntries.length })}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={!canTransfer}
            onClick={() => {
              onUpload(selectedEntries);
              setSelected(new Set());
            }}
          >
            <UploadIcon className="mr-1.5 h-4 w-4" />
            {t("files.local.upload")}
          </Button>
        </div>
      )}

      <div
        className={cn("min-h-0 flex-1 overflow-y-auto", over && "bg-primary/5 ring-2 ring-inset ring-primary")}
        onDragOver={(e) => {
          // also swallows files dragged in from the desktop, which the browser would otherwise open
          e.preventDefault();
          const ok = ready && acceptsDrop();
          e.dataTransfer.dropEffect = ok ? "copy" : "none";
          setOver(ok);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (ready && acceptsDrop()) onDrop();
        }}
      >
        {(status === "idle" || status === "loading") && (
          <div className="flex items-center justify-center p-10 text-muted-foreground">
            <LoaderCircle className="h-4 w-4 animate-spin" />
          </div>
        )}
        {status !== "idle" && status !== "loading" && status !== "ready" && (
          <div className="mx-auto max-w-sm space-y-3 p-6 text-center">
            <p className={cn("text-sm", status === "none" || status === "prompt" ? "text-muted-foreground" : "text-destructive")}>
              {status === "none"
                ? t("files.local.intro")
                : status === "prompt"
                  ? t("files.local.promptDesc", { name: local.stack[0]?.name ?? "" })
                  : t(`files.local.errors.${status}`)}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {(status === "prompt" || status === "denied") && (
                <Button onClick={() => void local.reconnect()}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {t("files.local.reconnect")}
                </Button>
              )}
              <Button variant={status === "prompt" || status === "denied" ? "outline" : "default"} onClick={() => void local.choose()}>
                <FolderOpen className="mr-2 h-4 w-4" />
                {t("files.local.choose")}
              </Button>
            </div>
          </div>
        )}
        {ready && (
          <ul className="divide-y" aria-busy={local.busy}>
            {entries.length === 0 && <li className="px-4 py-8 text-center text-sm text-muted-foreground">{t("files.local.empty")}</li>}
            {entries.map((e) => (
              <li
                key={e.name}
                // as tall as the remote rows (which have a menu button)
                className="flex min-h-10 items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/50"
                draggable={canTransfer}
                onDragStart={(ev) => {
                  const items = selected.has(e.name) ? selectedEntries : [e];
                  ev.dataTransfer.effectAllowed = "copy";
                  ev.dataTransfer.setData(DRAG_TYPE, items.map((i) => i.name).join("\n"));
                  onDragRows(items);
                }}
                onDragEnd={() => onDragRows(null)}
              >
                <Checkbox checked={selected.has(e.name)} onCheckedChange={(v) => toggle(e.name, v === true)} aria-label={e.name} />
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => (e.kind === "directory" ? local.enter(e) : toggle(e.name, !selected.has(e.name)))}
                  title={e.name}
                >
                  {e.kind === "directory" ? <Folder className="h-4 w-4 shrink-0 text-amber-500" /> : <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />}
                  <span className="min-w-0 flex-1 truncate">{e.name}</span>
                </button>
                <span className="hidden w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:inline">{e.kind === "directory" ? "" : formatSize(e.size, lang)}</span>
                <span className={cn("hidden w-32 shrink-0 text-right text-xs tabular-nums text-muted-foreground", split ? "lg:inline" : "md:inline")}>
                  {e.modified ? new Date(e.modified).toLocaleString(lang, { dateStyle: "short", timeStyle: "short" }) : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
