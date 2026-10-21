import { ArrowDown, ChevronDown, ChevronLeft, ChevronUp, Plus, RefreshCw, Search, Settings2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { TerminalSession } from "../terminal.js";
import { ConnectPane, type ConnState } from "./FilesSheet.js";
import { useI18n } from "./i18n/index.js";
import { cn, SCOPE } from "./lib/utils.js";
import { DEFAULT_STORAGE_KEY, loadRememberedHash } from "./prefs.js";
import type { RemoteDesktopProps } from "./RemoteDesktop.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";
import { Checkbox } from "./ui/misc.js";
import { localShellStore, type SavedShells } from "./shellStore.js";
import { XTERM_CSS } from "./xtermCss.js";

const KNOWN_ERRORS = ["offline", "not-found", "key-mismatch", "login-required", "timeout", "network", "unreachable", "handshake", "unverified-peer", "refused"];

/** Keys a phone keyboard lacks, as terminal input. */
/** Keys repeated while held (like a hardware keyboard). */
const REPEATING = new Set(["↑", "↓", "←", "→"]);
const REPEAT_DELAY_MS = 400;
const REPEAT_EVERY_MS = 60;

const EXTRA_KEYS: [string, string][] = [
  ["Esc", "\x1b"],
  ["Tab", "\t"],
  ["^C", "\x03"],
  ["^D", "\x04"],
  ["↑", "\x1b[A"],
  ["↓", "\x1b[B"],
  ["←", "\x1b[D"],
  ["→", "\x1b[C"],
];

const SYSTEM_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
const NERD_FAMILY = "rdweb Nerd Symbols";

/** Terminal look, kept in this browser (<storageKey>.terminal). */
export interface TerminalPrefs {
  /** A font installed on this computer, e.g. "JetBrainsMono Nerd Font"; "" = system monospace. */
  fontFamily: string;
  fontSize: number;
  /** Built-in Symbols Nerd Font as fallback for prompt icons. */
  nerdSymbols: boolean;
  /** Keep the shells running on the device when the connection drops, and reattach. */
  persistent: boolean;
  /** Copy the selection to the clipboard as soon as it is made. */
  copyOnSelect: boolean;
  /** Right click: copy the selection, or paste when nothing is selected. */
  rightClickPaste: boolean;
  /** macOS: Option works as Alt/Meta (Option+M sends Alt+M) instead of typing special characters. */
  optionAsAlt: boolean;
}

const DEFAULT_TERMINAL_PREFS: TerminalPrefs = {
  fontFamily: "",
  fontSize: 14,
  nerdSymbols: true,
  persistent: true,
  copyOnSelect: true,
  rightClickPaste: true,
  optionAsAlt: true,
};

function loadTerminalPrefs(storageKey: string): TerminalPrefs {
  try {
    const raw = localStorage.getItem(`${storageKey}.terminal`);
    const v = raw ? (JSON.parse(raw) as Partial<TerminalPrefs>) : {};
    return {
      fontFamily: typeof v.fontFamily === "string" ? v.fontFamily.slice(0, 100) : "",
      fontSize: typeof v.fontSize === "number" && v.fontSize >= 8 && v.fontSize <= 32 ? v.fontSize : 14,
      nerdSymbols: v.nerdSymbols !== false,
      persistent: v.persistent !== false,
      copyOnSelect: v.copyOnSelect !== false,
      rightClickPaste: v.rightClickPaste !== false,
      optionAsAlt: v.optionAsAlt !== false,
    };
  } catch {
    return { ...DEFAULT_TERMINAL_PREFS };
  }
}

function saveTerminalPrefs(storageKey: string, p: TerminalPrefs): void {
  try {
    localStorage.setItem(`${storageKey}.terminal`, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

/** The device's service id of this browser tab's shells (sessionStorage: survives reloads, not other tabs). */
function serviceKey(storageKey: string, serverKey: string, peerId: string): string {
  return `${storageKey}.terminal.service.${serverKey.trim()}.${peerId}`;
}

function loadService(key: string): string | undefined {
  try {
    return sessionStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function storeService(key: string, id: string | null): void {
  try {
    if (id) sessionStorage.setItem(key, id);
    else sessionStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

/** CSS font list: the chosen font, system monospace, then the icon font. */
function fontStack(p: TerminalPrefs): string {
  const own = p.fontFamily.trim().replace(/["\\;{}]/g, "");
  return [own ? `"${own}"` : "", SYSTEM_MONO, p.nerdSymbols ? `"${NERD_FAMILY}"` : ""].filter(Boolean).join(", ");
}

let nerdLoading: Promise<void> | null = null;

/** Registers the built-in Symbols Nerd Font (once per page). */
function loadNerdSymbols(): Promise<void> {
  if (typeof document === "undefined" || typeof FontFace === "undefined") return Promise.resolve();
  nerdLoading ??= import("./fonts/nerdSymbols.js")
    .then(async ({ NERD_SYMBOLS_WOFF2 }) => {
      const bin = atob(NERD_SYMBOLS_WOFF2);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const face = new FontFace(NERD_FAMILY, bytes);
      document.fonts.add(await face.load());
    })
    .catch(() => {
      nerdLoading = null; // icons fall back to boxes; try again next time
    });
  return nerdLoading;
}

function injectXtermCss(): void {
  if (typeof document === "undefined" || document.getElementById("rdweb-xterm-css")) return;
  const style = document.createElement("style");
  style.id = "rdweb-xterm-css";
  style.textContent = `${XTERM_CSS}\n.rdweb .xterm .xterm-viewport { scrollbar-color: rgba(255,255,255,.3) transparent; scrollbar-width: thin; }`;
  document.head.appendChild(style);
}

const MAX_TABS = 8;

type XtermLib = {
  Terminal: typeof import("@xterm/xterm").Terminal;
  FitAddon: typeof import("@xterm/addon-fit").FitAddon;
  SearchAddon: typeof import("@xterm/addon-search").SearchAddon;
  WebLinksAddon: typeof import("@xterm/addon-web-links").WebLinksAddon;
  Unicode11Addon: typeof import("@xterm/addon-unicode11").Unicode11Addon;
};

const SEARCH_DECORATIONS = {
  matchBackground: "#f59e0b55",
  matchOverviewRuler: "#f59e0b",
  activeMatchBackground: "#f59e0bcc",
  activeMatchColorOverviewRuler: "#fbbf24",
};

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Opens http(s) links from the terminal in a new tab (nothing else). */
function openLink(_e: MouseEvent, uri: string): void {
  try {
    const u = new URL(uri);
    if (u.protocol === "http:" || u.protocol === "https:") window.open(u.href, "_blank", "noopener,noreferrer");
  } catch {
    /* not a URL */
  }
}

interface Pane {
  term: import("@xterm/xterm").Terminal;
  fit: { fit(): void };
  search: import("@xterm/addon-search").SearchAddon;
  /** While replayed output is parsed: xterm's answers to queries in it are not sent. */
  replaying: boolean;
}

interface Tab {
  id: number;
  exited: boolean;
}

/** Remote shells only (RustDesk "Terminal"), full screen, in tabs over one connection. */
export function RemoteTerminal(props: RemoteDesktopProps & { onReconnect: () => void }) {
  const { t } = useI18n();
  const storageKey = props.storageKey ?? DEFAULT_STORAGE_KEY;
  const sessRef = useRef<TerminalSession | null>(null);
  const libRef = useRef<XtermLib | null>(null);
  const panes = useRef(new Map<number, Pane>());
  const hosts = useRef(new Map<number, HTMLDivElement>());
  const areaRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);
  const leavingRef = useRef(false);
  const store = useMemo(() => props.shellStore ?? localShellStore(storageKey, props.server.key, props.peerId), []);
  const serviceRef = useRef<SavedShells | null>(null);
  const [choices, setChoices] = useState<SavedShells[] | null>(null);
  const chooseRef = useRef<((c: { kind: "new" } | { kind: "restore" | "close"; shells: SavedShells }) => void) | null>(null);
  const svcKey = serviceKey(storageKey, props.server.key, props.peerId);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [error, setError] = useState("");
  const [wrong, setWrong] = useState(false);
  const [secret, setSecret] = useState("");
  const [ended, setEnded] = useState<string | null>(null);
  const [title, setTitle] = useState(props.peerId);
  const [prefs, setPrefs] = useState<TerminalPrefs>(() => loadTerminalPrefs(storageKey));
  const prefsRef = useRef(prefs);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scrolledUp, setScrolledUp] = useState(false);
  const [autoRetry, setAutoRetry] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [tabs, setTabs] = useState<Tab[]>([{ id: 0, exited: false }]);
  const [active, setActive] = useState(0);
  const activeRef = useRef(0);
  const touch = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
  // Ctrl / Alt from the extra keys bar, applied to the next key typed
  const [sticky, setSticky] = useState<{ ctrl: boolean; alt: boolean }>({ ctrl: false, alt: false });
  // held extra key: the pending delay, then the repeat interval
  const repeatRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopRepeat = () => {
    if (repeatRef.current !== null) {
      clearTimeout(repeatRef.current);
      clearInterval(repeatRef.current);
      repeatRef.current = null;
    }
  };
  useEffect(() => stopRepeat, []);
  const stickyRef = useRef(sticky);
  stickyRef.current = sticky;
  const applySticky = (d: string): string => {
    const m = stickyRef.current;
    if ((!m.ctrl && !m.alt) || [...d].length !== 1) return d;
    let out = d;
    if (m.ctrl) {
      const c = d.toUpperCase().charCodeAt(0);
      if (c >= 0x40 && c <= 0x5f) out = String.fromCharCode(c & 0x1f); // Ctrl+A..Z, [ \\ ] ^ _
      else if (d === " ") out = "\x00";
    }
    if (m.alt) out = `\x1b${out}`;
    setSticky({ ctrl: false, alt: false });
    return out;
  };

  const updateScrolled = (id: number) => {
    if (id !== activeRef.current) return;
    const b = panes.current.get(id)?.term.buffer.active;
    if (b) setScrolledUp(b.viewportY < b.baseY);
  };

  const fitActive = () => {
    const id = activeRef.current;
    const p = panes.current.get(id);
    if (!p) return;
    try {
      p.fit.fit();
      sessRef.current?.resize(p.term.cols, p.term.rows, id);
    } catch {
      /* hidden or detached */
    }
  };

  /** An xterm in the tab's host element; keystrokes go to that tab's shell. */
  const createPane = (id: number): Pane | null => {
    const lib = libRef.current;
    const el = hosts.current.get(id);
    if (!lib || !el) return null;
    const term = new lib.Terminal({
      cursorBlink: true,
      fontFamily: fontStack(prefsRef.current),
      fontSize: prefsRef.current.fontSize,
      scrollback: 10000,
      theme: { background: "#0a0a0a" },
      allowProposedApi: true, // unicode11 and search decorations
      rightClickSelectsWord: false,
      macOptionIsMeta: prefsRef.current.optionAsAlt,
    });
    const fit = new lib.FitAddon();
    const search = new lib.SearchAddon();
    const pane: Pane = { term, fit, search, replaying: false };
    term.loadAddon(search);
    term.loadAddon(new lib.WebLinksAddon(openLink));
    term.loadAddon(new lib.Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    term.onData((d) => {
      if (pane.replaying) return;
      sessRef.current?.write(applySticky(d), id);
    });
    // Shift+PageUp/PageDown/Home/End page through the scrollback (like most terminals)
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      // Shift+Enter: a newline for CLIs like Gemini or Claude (ESC CR, as Alt+Enter)
      if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        sessRef.current?.write("\x1b\r", id);
        return false;
      }
      // search: Ctrl+Shift+F (Cmd+F on macOS)
      if ((isMac ? e.metaKey && !e.shiftKey : e.ctrlKey && e.shiftKey) && e.code === "KeyF" && !e.altKey) {
        e.preventDefault();
        setSearchOpen(true);
        return false;
      }
      // font size: Ctrl/Cmd + = - 0
      if (mod && !e.altKey && (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "0")) {
        e.preventDefault();
        const size = e.key === "0" ? DEFAULT_TERMINAL_PREFS.fontSize : prefsRef.current.fontSize + (e.key === "-" ? -1 : 1);
        void applyPrefs({ ...prefsRef.current, fontSize: Math.min(32, Math.max(8, size)) });
        return false;
      }
      // Shift+PageUp/PageDown/Home/End page through the scrollback (like most terminals)
      if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return true;
      const act: Record<string, () => void> = {
        PageUp: () => term.scrollPages(-1),
        PageDown: () => term.scrollPages(1),
        Home: () => term.scrollToTop(),
        End: () => term.scrollToBottom(),
      };
      const fn = act[e.key];
      if (!fn) return true;
      fn();
      return false;
    });
    term.onSelectionChange(() => {
      if (prefsRef.current.copyOnSelect && term.hasSelection()) void navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
    });
    el.addEventListener("contextmenu", (e) => {
      if (!prefsRef.current.rightClickPaste) return;
      e.preventDefault();
      if (term.hasSelection()) {
        void navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
        term.clearSelection();
        return;
      }
      void navigator.clipboard
        ?.readText()
        .then((text) => {
          if (text) term.paste(text); // bracketed paste when the shell asked for it
        })
        .catch(() => {});
    });
    term.onScroll(() => updateScrolled(id));
    term.onWriteParsed(() => updateScrolled(id));
    panes.current.set(id, pane);
    return pane;
  };

  // Load xterm (and the icon font), open the first tab, connect.
  useEffect(() => {
    let disposed = false;
    let opened = false;
    let ro: ResizeObserver | null = null;
    void (async () => {
      const [{ Terminal }, { FitAddon }, { SearchAddon }, { WebLinksAddon }, { Unicode11Addon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-search"),
        import("@xterm/addon-web-links"),
        import("@xterm/addon-unicode11"),
      ]);
      if (prefsRef.current.nerdSymbols) await loadNerdSymbols();
      if (disposed) return;
      injectXtermCss();
      libRef.current = { Terminal, FitAddon, SearchAddon, WebLinksAddon, Unicode11Addon };
      const first = createPane(0);
      if (!first) return;
      // This tab's shells (reload, reconnect), else offer the device's remembered ones.
      let serviceId = prefsRef.current.persistent ? loadService(svcKey) : undefined;
      let closing: SavedShells | null = null;
      if (prefsRef.current.persistent && !serviceId) {
        const saved = await store.list().catch(() => [] as SavedShells[]);
        if (disposed) return;
        if (saved.length) {
          const choice = await new Promise<{ kind: "new" } | { kind: "restore" | "close"; shells: SavedShells }>((resolve) => {
            chooseRef.current = resolve;
            setChoices(saved);
          });
          setChoices(null);
          if (disposed) return;
          if (choice.kind !== "new") {
            serviceId = choice.shells.serviceId;
            serviceRef.current = choice.shells;
            if (choice.kind === "close") closing = choice.shells;
          }
        }
      }
      const s = new TerminalSession({
        peerId: props.peerId,
        server: props.server,
        rememberedHash: loadRememberedHash(props.server.key, props.peerId, storageKey) ?? props.credentials?.rememberedHash,
        myName: props.myName,
        myId: props.myId || undefined,
        cols: first.term.cols,
        rows: first.term.rows,
        persistent: prefsRef.current.persistent,
        serviceId,
      });
      sessRef.current = s;
      let hostPasswordTried = !props.credentials?.password;
      s.on("password", ({ wrong }) => {
        if (!wrong && !hostPasswordTried) {
          hostPasswordTried = true;
          void s.login(props.credentials!.password!);
          return;
        }
        setWrong(wrong);
        setConn("password");
      });
      s.on("twoFactor", ({ wrong }) => {
        setWrong(wrong);
        setConn("twoFactor");
      });
      s.on("waitingForApproval", () => setConn("waiting"));
      s.on("data", ({ terminalId, data, replay }) => {
        const p = panes.current.get(terminalId);
        if (!p) return;
        if (!replay) {
          p.term.write(data);
          return;
        }
        p.replaying = true;
        p.term.write(data, () => {
          p.replaying = false;
        });
      });
      s.on("exit", ({ terminalId, code }) => {
        panes.current.get(terminalId)?.term.write(`\r\n[${t("terminal.exited", { code })}]\r\n`);
        setTabs((list) => list.map((x) => (x.id === terminalId ? { ...x, exited: true } : x)));
      });
      s.on("close", (info) => {
        // before the shell opened, connect() rejects and shows the error instead
        if (disposed || !opened || closing) return;
        setEnded(info.reason);
        // a dropped connection: the device keeps the shells, get them back
        if (prefsRef.current.persistent && info.retryable && !info.remote) setAutoRetry(true);
        else forget();
      });
      ro = new ResizeObserver(fitActive);
      if (areaRef.current) ro.observe(areaRef.current);
      await s.connect();
      opened = true;
      if (disposed) return;
      const p = s.peer;
      if (p) setTitle(p.hostname ? `${p.hostname} · ${props.peerId}` : props.peerId);
      if (closing) {
        // "Close": end the remembered shells, then offer the rest again
        s.closeService();
        await store.remove(closing.serviceId).catch(() => {});
        props.onReconnect();
        return;
      }
      if (prefsRef.current.persistent && s.serviceId) {
        storeService(svcKey, s.serviceId);
        const now = Date.now();
        serviceRef.current = {
          serviceId: s.serviceId,
          hostname: p?.hostname || undefined,
          tabs: 1 + s.restorable.length,
          createdAt: serviceRef.current?.serviceId === s.serviceId ? serviceRef.current.createdAt : now,
          updatedAt: now,
        };
        void store.save(serviceRef.current).catch(() => {});
      }
      // a reattached service: its other shells come back as tabs
      const restore = s.restorable;
      if (restore.length) {
        nextId.current = Math.max(...restore) + 1;
        setTabs([{ id: 0, exited: false }, ...restore.map((id) => ({ id, exited: false }))]);
      }
      setConn("ready");
      first.term.focus();
    })().catch((e: Error & { code?: string }) => {
      if (disposed) return;
      setError(e.code && KNOWN_ERRORS.includes(e.code) ? t(`errors.${e.code}`, { detail: e.message }) : e.message);
      setConn("error");
    });
    return () => {
      disposed = true;
      ro?.disconnect();
      // leaving ends the shells; a remount (reconnect) keeps a persistent service's shells
      sessRef.current?.close("closed", { keepShells: prefsRef.current.persistent && !leavingRef.current });
      sessRef.current = null;
      for (const p of panes.current.values()) p.term.dispose();
      panes.current.clear();
    };
    // one session per mount; the host remounts to reconnect
  }, []);

  // A new tab: its host element exists now; open a shell for it.
  useEffect(() => {
    const s = sessRef.current;
    if (!s || !libRef.current) return;
    for (const tab of tabs) {
      if (panes.current.has(tab.id) || tab.exited) continue;
      const pane = createPane(tab.id);
      if (!pane) continue;
      s.openTerminal(tab.id, pane.term.cols, pane.term.rows).catch((e: Error) => {
        pane.term.write(`\r\n[${e.message}]\r\n`);
        setTabs((list) => list.map((x) => (x.id === tab.id ? { ...x, exited: true } : x)));
      });
    }
  }, [tabs]);

  // Switching tabs: fit, resize that shell, focus.
  useEffect(() => {
    activeRef.current = active;
    fitActive();
    panes.current.get(active)?.term.focus();
    updateScrolled(active);
  }, [active]);

  // Reconnect on our own after a drop (the device kept the shells).
  useEffect(() => {
    if (!autoRetry) return;
    const timer = setTimeout(props.onReconnect, 2000);
    return () => clearTimeout(timer);
  }, [autoRetry, props.onReconnect]);

  /** The shells are gone (or ended on purpose): drop them from both stores. */
  const forget = () => {
    storeService(svcKey, null);
    const id = serviceRef.current?.serviceId;
    serviceRef.current = null;
    if (id) void store.remove(id).catch(() => {});
  };

  /** Back: end the shells (not kept for a reattach). */
  const leave = () => {
    leavingRef.current = true;
    forget();
    chooseRef.current?.({ kind: "new" });
    props.onLeave();
  };

  // Keep the remembered tab count current.
  useEffect(() => {
    const rec = serviceRef.current;
    if (!rec || conn !== "ready" || rec.tabs === tabs.length) return;
    serviceRef.current = { ...rec, tabs: tabs.length, updatedAt: Date.now() };
    void store.save(serviceRef.current).catch(() => {});
  }, [tabs.length, conn]);

  const addTab = () => {
    if (conn !== "ready" || tabs.length >= MAX_TABS) return;
    const id = nextId.current++;
    setTabs((list) => [...list, { id, exited: false }]);
    setActive(id);
  };

  const closeTab = (id: number) => {
    const rest = tabs.filter((x) => x.id !== id);
    if (rest.length === 0) {
      leave();
      return;
    }
    sessRef.current?.closeTerminal(id);
    panes.current.get(id)?.term.dispose();
    panes.current.delete(id);
    hosts.current.delete(id);
    setTabs(rest);
    if (active === id) setActive(rest[rest.length - 1]!.id);
  };

  const find = (back: boolean, text = query) => {
    const p = panes.current.get(active);
    if (!p || !text) return;
    const opts = { decorations: SEARCH_DECORATIONS };
    if (back) p.search.findPrevious(text, opts);
    else p.search.findNext(text, opts);
  };

  const closeSearch = () => {
    setSearchOpen(false);
    const p = panes.current.get(active);
    p?.search.clearDecorations();
    p?.term.clearSelection();
    p?.term.focus();
  };

  const applyPrefs = async (next: TerminalPrefs) => {
    setPrefs(next);
    prefsRef.current = next;
    saveTerminalPrefs(storageKey, next);
    if (next.nerdSymbols) await loadNerdSymbols();
    for (const p of panes.current.values()) {
      p.term.options.fontFamily = fontStack(next);
      p.term.options.fontSize = next.fontSize;
      p.term.options.macOptionIsMeta = next.optionAsAlt;
    }
    fitActive();
  };

  // Pinch with two fingers on the terminal: font size follows, saved on release.
  const applyRef = useRef(applyPrefs);
  applyRef.current = applyPrefs;
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    let start: { dist: number; size: number } | null = null;
    let size = 0;
    const dist = (t: TouchList) => Math.hypot(t[0]!.clientX - t[1]!.clientX, t[0]!.clientY - t[1]!.clientY);
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      start = { dist: dist(e.touches), size: prefsRef.current.fontSize };
      size = start.size;
    };
    const onMove = (e: TouchEvent) => {
      if (!start || e.touches.length !== 2) return;
      e.preventDefault(); // no page zoom, no scrolling while pinching
      const next = Math.min(32, Math.max(8, Math.round(start.size * (dist(e.touches) / start.dist))));
      if (next === size) return;
      size = next;
      for (const p of panes.current.values()) p.term.options.fontSize = next;
      fitActive();
    };
    const onEnd = (e: TouchEvent) => {
      if (!start || e.touches.length >= 2) return;
      const changed = size !== start.size;
      start = null;
      if (changed) void applyRef.current({ ...prefsRef.current, fontSize: size });
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, []);

  const overlay = conn !== "ready" && !ended && !choices;
  const ready = conn === "ready" && !ended;
  return (
    <div className={cn(SCOPE, "fixed inset-0 flex flex-col bg-[#0a0a0a] text-white", props.className)}>
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-2 py-2">
        <Button size="icon" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" aria-label={t("toolbar.back")} title={t("toolbar.back")} onClick={leave}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <div className="min-w-0 flex-1 truncate text-sm font-medium">
          {t("terminal.title")} · {title}
        </div>
        <Button size="icon" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" aria-label={t("terminal.search")} title={`${t("terminal.search")} (${isMac ? "⌘F" : "Ctrl+Shift+F"})`} onClick={() => setSearchOpen((o) => !o)}>
          <Search className="h-5 w-5" />
        </Button>
        <Button size="icon" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" aria-label={t("terminal.settings")} title={t("terminal.settings")} onClick={() => setSettingsOpen(true)}>
          <Settings2 className="h-5 w-5" />
        </Button>
      </div>
      <TerminalSettings open={settingsOpen} onOpenChange={setSettingsOpen} prefs={prefs} onApply={(p) => void applyPrefs(p)} />
      {ready && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-white/10 px-2 py-1" role="tablist" aria-label={t("terminal.tabs")}>
          {tabs.map((tab, i) => (
            <div
              key={tab.id}
              className={cn(
                "flex shrink-0 items-center rounded-md text-xs",
                tab.id === active ? "bg-white/15 text-white" : "text-white/60 hover:bg-white/10 hover:text-white",
              )}
            >
              <button type="button" role="tab" aria-selected={tab.id === active} className="px-2.5 py-1.5" onClick={() => setActive(tab.id)}>
                {t("terminal.tab", { n: i + 1 })}
                {tab.exited ? " ·" : ""}
              </button>
              <button
                type="button"
                className="mr-1 rounded p-0.5 hover:bg-white/20"
                aria-label={t("terminal.closeTab")}
                title={t("terminal.closeTab")}
                onClick={() => closeTab(tab.id)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          {tabs.length < MAX_TABS && (
            <button
              type="button"
              className="shrink-0 rounded-md p-1.5 text-white/60 hover:bg-white/10 hover:text-white"
              aria-label={t("terminal.newTab")}
              title={t("terminal.newTab")}
              onClick={addTab}
            >
              <Plus className="h-4 w-4" />
            </button>
          )}
        </div>
      )}
      <div ref={areaRef} className="relative min-h-0 flex-1 p-1.5">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            ref={(el) => {
              if (el) hosts.current.set(tab.id, el);
            }}
            className={cn("h-full w-full", tab.id !== active && "hidden")}
          />
        ))}
        {searchOpen && ready && (
          <form
            className="absolute right-4 top-3 z-10 flex items-center gap-1 rounded-md border border-white/15 bg-neutral-900/95 p-1 shadow-lg"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              find(false);
            }}
          >
            <Search className="ml-1 h-4 w-4 text-white/50" />
            <input
              autoFocus
              value={query}
              placeholder={t("terminal.search")}
              aria-label={t("terminal.search")}
              className="w-44 bg-transparent px-1 py-1 text-sm text-white outline-none placeholder:text-white/40"
              onChange={(e) => {
                setQuery(e.target.value);
                find(false, e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  closeSearch();
                } else if (e.key === "Enter" && e.shiftKey) {
                  e.preventDefault();
                  find(true);
                }
              }}
            />
            <button type="button" className="rounded p-1 text-white/70 hover:bg-white/10" aria-label={t("terminal.searchPrev")} title={t("terminal.searchPrev")} onClick={() => find(true)}>
              <ChevronUp className="h-4 w-4" />
            </button>
            <button type="submit" className="rounded p-1 text-white/70 hover:bg-white/10" aria-label={t("terminal.searchNext")} title={t("terminal.searchNext")}>
              <ChevronDown className="h-4 w-4" />
            </button>
            <button type="button" className="rounded p-1 text-white/70 hover:bg-white/10" aria-label={t("common.close")} title={t("common.close")} onClick={closeSearch}>
              <X className="h-4 w-4" />
            </button>
          </form>
        )}
        {scrolledUp && ready && (
          <Button
            size="sm"
            variant="secondary"
            className="absolute bottom-3 right-4 shadow-lg"
            aria-label={t("terminal.toBottom")}
            title={t("terminal.toBottom")}
            onClick={() => {
              const p = panes.current.get(active);
              p?.term.scrollToBottom();
              p?.term.focus();
            }}
          >
            <ArrowDown className="h-4 w-4" />
          </Button>
        )}
        {choices && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/80 p-4">
            <div className="w-full max-w-md space-y-3 rounded-lg border bg-background p-5 text-foreground">
              <div>
                <h2 className="text-base font-semibold">{t("terminal.saved.title")}</h2>
                <p className="text-sm text-muted-foreground">{t("terminal.saved.desc")}</p>
              </div>
              <ul className="max-h-72 space-y-2 overflow-y-auto">
                {choices.map((c) => (
                  <li key={c.serviceId} className="flex flex-wrap items-center gap-2 rounded-md border p-2.5">
                    <div className="min-w-0 flex-1 text-sm">
                      <div className="truncate font-medium">
                        {c.hostname ? `${c.hostname} · ` : ""}
                        {t("terminal.saved.item", { count: c.tabs })}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {t("terminal.saved.when", { time: new Date(c.updatedAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }) })}
                      </div>
                    </div>
                    <Button size="sm" onClick={() => chooseRef.current?.({ kind: "restore", shells: c })}>
                      {t("terminal.saved.restore")}
                    </Button>
                    <Button size="sm" variant="outline" title={t("terminal.saved.closeHint")} onClick={() => chooseRef.current?.({ kind: "close", shells: c })}>
                      {t("terminal.saved.close")}
                    </Button>
                  </li>
                ))}
              </ul>
              <Button className="w-full" variant="secondary" onClick={() => chooseRef.current?.({ kind: "new" })}>
                <Plus className="mr-2 h-4 w-4" />
                {t("terminal.saved.new")}
              </Button>
            </div>
          </div>
        )}
        {(overlay || ended) && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 p-4">
            <div className="w-full max-w-sm rounded-lg border bg-background text-foreground">
              {ended ? (
                <div className="space-y-3 p-6 text-center">
                  <p className="text-sm">{t("terminal.ended", { reason: ended })}</p>
                  {autoRetry && <p className="text-xs text-muted-foreground">{t("terminal.reconnecting")}</p>}
                  <div className="flex justify-center gap-2">
                    <Button size="sm" onClick={props.onReconnect}>
                      <RefreshCw className="mr-2 h-4 w-4" />
                      {t("reconnect")}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={leave}>
                      {t("common.back")}
                    </Button>
                  </div>
                </div>
              ) : (
                <ConnectPane
                  state={conn}
                  error={error}
                  wrong={wrong}
                  secret={secret}
                  setSecret={setSecret}
                  passwordDesc={t("terminal.passwordDesc")}
                  connectingText={t("terminal.connecting")}
                  onSubmit={() => {
                    const s = sessRef.current;
                    if (!s) return;
                    if (conn === "twoFactor") s.submitTwoFactor(secret);
                    else void s.login(secret);
                    setSecret("");
                    setConn("connecting");
                  }}
                  onRetry={props.onReconnect}
                />
              )}
            </div>
          </div>
        )}
      </div>
      {touch && ready && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-t border-white/10 px-1.5 py-1.5" aria-label={t("terminal.keys")}>
          {(["ctrl", "alt"] as const).map((m) => (
            <Button
              key={m}
              size="sm"
              variant="ghost"
              aria-pressed={sticky[m]}
              className={cn("h-11 min-w-11 shrink-0 px-3.5 font-mono text-base text-white hover:bg-white/10 hover:text-white", sticky[m] && "bg-primary text-primary-foreground hover:bg-primary")}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setSticky((s) => ({ ...s, [m]: !s[m] }));
                panes.current.get(active)?.term.focus();
              }}
            >
              {m === "ctrl" ? "Ctrl" : "Alt"}
            </Button>
          ))}
          {EXTRA_KEYS.map(([label, seq]) => (
            <Button
              key={label}
              size="sm"
              variant="ghost"
              className="h-11 min-w-11 shrink-0 touch-none select-none px-3.5 font-mono text-base text-white hover:bg-white/10 hover:text-white"
              onMouseDown={(e) => e.preventDefault()}
              onPointerDown={(e) => {
                e.preventDefault();
                const send = () => sessRef.current?.write(stickyRef.current.alt && seq.length === 1 ? applySticky(seq) : seq, active);
                send();
                stopRepeat();
                if (REPEATING.has(label)) {
                  repeatRef.current = setTimeout(() => {
                    repeatRef.current = setInterval(send, REPEAT_EVERY_MS);
                  }, REPEAT_DELAY_MS);
                }
              }}
              onPointerUp={stopRepeat}
              onPointerLeave={stopRepeat}
              onPointerCancel={stopRepeat}
              onContextMenu={(e) => e.preventDefault()}
            >
              {label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function TerminalSettings({
  open,
  onOpenChange,
  prefs,
  onApply,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  prefs: TerminalPrefs;
  onApply: (p: TerminalPrefs) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(prefs);
  useEffect(() => {
    if (open) setDraft(prefs);
  }, [open, prefs]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(SCOPE, "max-w-[calc(100vw-2rem)] sm:max-w-md")} closeLabel={t("common.close")}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            onApply({ ...draft, fontSize: Math.min(32, Math.max(8, Math.round(draft.fontSize) || 14)) });
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("terminal.settings")}</DialogTitle>
            <DialogDescription>{t("terminal.settingsDesc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="rdweb-term-font">{t("terminal.fontFamily")}</Label>
            <Input
              id="rdweb-term-font"
              value={draft.fontFamily}
              maxLength={100}
              placeholder="JetBrainsMono Nerd Font"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setDraft({ ...draft, fontFamily: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">{t("terminal.fontFamilyHint")}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rdweb-term-size">{t("terminal.fontSize")}</Label>
            <Input
              id="rdweb-term-size"
              type="number"
              min={8}
              max={32}
              value={draft.fontSize}
              onChange={(e) => setDraft({ ...draft, fontSize: Number(e.target.value) })}
              className="w-24"
            />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={draft.nerdSymbols} onCheckedChange={(v) => setDraft({ ...draft, nerdSymbols: v === true })} className="mt-0.5" />
            <span>
              {t("terminal.nerdSymbols")}
              <span className="block text-xs text-muted-foreground">{t("terminal.nerdSymbolsHint")}</span>
            </span>
          </label>
          {isMac && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={draft.optionAsAlt} onCheckedChange={(v) => setDraft({ ...draft, optionAsAlt: v === true })} className="mt-0.5" />
              <span>
                {t("terminal.optionAsAlt")}
                <span className="block text-xs text-muted-foreground">{t("terminal.optionAsAltHint")}</span>
              </span>
            </label>
          )}
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={draft.copyOnSelect} onCheckedChange={(v) => setDraft({ ...draft, copyOnSelect: v === true })} className="mt-0.5" />
            <span>{t("terminal.copyOnSelect")}</span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={draft.rightClickPaste} onCheckedChange={(v) => setDraft({ ...draft, rightClickPaste: v === true })} className="mt-0.5" />
            <span>
              {t("terminal.rightClickPaste")}
              <span className="block text-xs text-muted-foreground">{t("terminal.keysHint")}</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={draft.persistent} onCheckedChange={(v) => setDraft({ ...draft, persistent: v === true })} className="mt-0.5" />
            <span>
              {t("terminal.persistent")}
              <span className="block text-xs text-muted-foreground">{t("terminal.persistentHint")}</span>
            </span>
          </label>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit">{t("common.save")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
