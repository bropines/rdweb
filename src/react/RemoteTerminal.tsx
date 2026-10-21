import { ArrowDown, ChevronDown, ChevronLeft, ChevronUp, Keyboard, Plus, RefreshCw, Search, Settings2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { TerminalSession } from "../terminal.js";
import { ExtraKeys } from "./ExtraKeys.js";
import { ConnectPane, type ConnState } from "./FilesSheet.js";
import { useI18n } from "./i18n/index.js";
import { cn, SCOPE } from "./lib/utils.js";
import { screenlessPeer } from "./peerSummary.js";
import { DEFAULT_STORAGE_KEY, loadRememberedHash, pushRecent, saveRememberedHash } from "./prefs.js";
import type { RemoteDesktopProps } from "./RemoteDesktop.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";
import { Checkbox } from "./ui/misc.js";
import { isModifier, modifyText, TERMINAL_LAYOUT, terminalKey, type TermMods } from "./keys.js";
import { attachInstantInput } from "./instantInput.js";
import { localShellStore, type SavedShells } from "./shellStore.js";
import { cellAt, extendFrom, selectBetween, wordAt, type Cell } from "./touchSelect.js";
import { useNoPullToRefresh, useVisualViewport } from "./viewport.js";
import { XTERM_CSS } from "./xtermCss.js";

const KNOWN_ERRORS = ["offline", "not-found", "key-mismatch", "login-required", "timeout", "network", "unreachable", "handshake", "unverified-peer", "refused"];

const MIN_FONT = 5;
const MAX_FONT = 32;
const RESIZE_SETTLE_MS = 150;
const LONG_PRESS_MS = 450;
const TAP_SLOP_PX = 6;

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
  /** Touch screens: send each letter as it is typed, not a whole word once the keyboard commits it. */
  instantInput: boolean;
}

const DEFAULT_TERMINAL_PREFS: TerminalPrefs = {
  fontFamily: "",
  fontSize: 14,
  nerdSymbols: true,
  persistent: true,
  copyOnSelect: true,
  rightClickPaste: true,
  optionAsAlt: true,
  instantInput: true,
};

function loadTerminalPrefs(storageKey: string): TerminalPrefs {
  try {
    const raw = localStorage.getItem(`${storageKey}.terminal`);
    const v = raw ? (JSON.parse(raw) as Partial<TerminalPrefs>) : {};
    return {
      fontFamily: typeof v.fontFamily === "string" ? v.fontFamily.slice(0, 100) : "",
      fontSize: typeof v.fontSize === "number" && v.fontSize >= MIN_FONT && v.fontSize <= MAX_FONT ? v.fontSize : 14,
      nerdSymbols: v.nerdSymbols !== false,
      persistent: v.persistent !== false,
      copyOnSelect: v.copyOnSelect !== false,
      rightClickPaste: v.rightClickPaste !== false,
      optionAsAlt: v.optionAsAlt !== false,
      instantInput: v.instantInput !== false,
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
  /** null when it failed to load: the DOM renderer. */
  WebglAddon: typeof import("@xterm/addon-webgl").WebglAddon | null;
};

const SEARCH_DECORATIONS = {
  matchBackground: "#f59e0b55",
  matchOverviewRuler: "#f59e0b",
  activeMatchBackground: "#f59e0bcc",
  activeMatchColorOverviewRuler: "#fbbf24",
};

const isTouch = () => typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;
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
  /** Removes instant input (see attachInstantInput). */
  detachInstant?: () => void;
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
  const [remember, setRemember] = useState(false);
  const rememberRef = useRef(false);
  rememberRef.current = remember;
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
  // touch selection: a long press selects a word, dragging extends it; then a small menu
  const [selMenu, setSelMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const touchSelecting = useRef(false);
  const lastTouch = useRef(0);
  const keysStateKey = `${storageKey}.terminal.keys`;
  const [keysHidden, setKeysHiddenRaw] = useState(() => {
    try {
      return localStorage.getItem(keysStateKey) === "hidden";
    } catch {
      return false;
    }
  });
  const setKeysHidden = (hidden: boolean) => {
    setKeysHiddenRaw(hidden);
    try {
      localStorage.setItem(keysStateKey, hidden ? "hidden" : "base");
    } catch {
      /* storage unavailable */
    }
  };
  const [active, setActive] = useState(0);
  const activeRef = useRef(0);
  const touch = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
  // Ctrl / Alt / Shift from the extra keys bar, applied to the next key typed
  const [sticky, setSticky] = useState<TermMods>({ ctrl: false, alt: false, shift: false });
  const stickyRef = useRef(sticky);
  stickyRef.current = sticky;
  const takeSticky = (): TermMods => {
    const m = stickyRef.current;
    if (m.ctrl || m.alt || m.shift) {
      stickyRef.current = { ctrl: false, alt: false, shift: false };
      setSticky(stickyRef.current);
    }
    return m;
  };
  const applySticky = (d: string): string => {
    const m = stickyRef.current;
    if ((!m.ctrl && !m.alt && !m.shift) || [...d].length !== 1) return d;
    return modifyText(d, takeSticky());
  };
  const rootRef = useRef<HTMLDivElement>(null);
  useVisualViewport(rootRef);

  const updateScrolled = (id: number) => {
    if (id !== activeRef.current) return;
    const b = panes.current.get(id)?.term.buffer.active;
    if (b) setScrolledUp(b.viewportY < b.baseY);
  };

  // The device's shell hears about a new size once it settles: every resize
  // makes ConPTY on Windows repaint the screen into the scrollback.
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentSize = useRef(new Map<number, string>());
  const fitActive = () => {
    const id = activeRef.current;
    const p = panes.current.get(id);
    if (!p) return;
    try {
      p.fit.fit();
    } catch {
      return; // hidden or detached
    }
    if (resizeTimer.current !== null) clearTimeout(resizeTimer.current);
    resizeTimer.current = setTimeout(() => {
      resizeTimer.current = null;
      const size = `${p.term.cols}x${p.term.rows}`;
      if (sentSize.current.get(id) === size) return;
      sentSize.current.set(id, size);
      sessRef.current?.resize(p.term.cols, p.term.rows, id);
    }, RESIZE_SETTLE_MS);
  };
  useEffect(
    () => () => {
      if (resizeTimer.current !== null) clearTimeout(resizeTimer.current);
    },
    [],
  );

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
      windowsPty: sessRef.current?.peer?.os === "windows" ? { backend: "conpty" } : undefined,
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
    // WebGL draws box drawing, blocks and powerline glyphs itself, so frames
    // and TUIs have no gaps whatever the font; without WebGL, the DOM renderer.
    if (lib.WebglAddon) {
      try {
        const gl = new lib.WebglAddon();
        gl.onContextLoss(() => gl.dispose());
        term.loadAddon(gl);
      } catch {
        /* no WebGL here */
      }
    }
    fit.fit();
    term.onData((d) => {
      if (pane.replaying) return;
      sessRef.current?.write(applySticky(d), id);
    });
    setInstantInput(pane, id, prefsRef.current.instantInput);
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
        void applyPrefs({ ...prefsRef.current, fontSize: Math.min(MAX_FONT, Math.max(MIN_FONT, size)) });
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
      if (!term.hasSelection()) {
        if (id === activeRef.current) setSelMenu(false);
        return;
      }
      if (prefsRef.current.copyOnSelect && !touchSelecting.current) void navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
    });
    el.addEventListener("contextmenu", (e) => {
      // a long press on a touch screen selects (see the touch handling), it does not paste
      if ((e as PointerEvent).pointerType === "touch" || Date.now() - lastTouch.current < 1500) {
        e.preventDefault();
        return;
      }
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
      const [{ Terminal }, { FitAddon }, { SearchAddon }, { WebLinksAddon }, { Unicode11Addon }, webgl] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-search"),
        import("@xterm/addon-web-links"),
        import("@xterm/addon-unicode11"),
        import("@xterm/addon-webgl").catch(() => null),
      ]);
      if (prefsRef.current.nerdSymbols) await loadNerdSymbols();
      if (disposed) return;
      injectXtermCss();
      libRef.current = { Terminal, FitAddon, SearchAddon, WebLinksAddon, Unicode11Addon, WebglAddon: webgl?.WebglAddon ?? null };
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
      s.on("connected", ({ rememberedHash }) => {
        if (!rememberedHash || !rememberRef.current) return;
        saveRememberedHash(props.server.key, props.peerId, rememberedHash, storageKey);
        void Promise.resolve(props.onRemembered?.(rememberedHash)).catch(() => {});
      });
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
      if (p) {
        pushRecent(props.peerId, p.hostname || undefined, storageKey);
        props.onConnected?.(screenlessPeer(p));
      }
      // ConPTY repaints on resize itself: no reflow on top of it
      if (p?.os === "windows") for (const pane of panes.current.values()) pane.term.options.windowsPty = { backend: "conpty" };
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

  /** On touch screens, letters typed on the on-screen keyboard go out one by one. */
  const setInstantInput = (pane: Pane, id: number, on: boolean) => {
    if (!touch || on === !!pane.detachInstant) return;
    if (on) {
      pane.detachInstant = attachInstantInput(
        pane.term,
        (d) => {
          if (!pane.replaying) sessRef.current?.write(applySticky(d), id);
        },
        // Delete, and a caret the keyboard moved itself
        (key) => {
          const seq = terminalKey(key, takeSticky(), pane.term.modes.applicationCursorKeysMode);
          if (seq !== null && !pane.replaying) sessRef.current?.write(seq, id);
        },
      );
    } else {
      pane.detachInstant?.();
      pane.detachInstant = undefined;
    }
  };

  const applyPrefs = async (next: TerminalPrefs) => {
    setPrefs(next);
    prefsRef.current = next;
    saveTerminalPrefs(storageKey, next);
    if (next.nerdSymbols) await loadNerdSymbols();
    for (const [id, p] of panes.current) {
      p.term.options.fontFamily = fontStack(next);
      p.term.options.fontSize = next.fontSize;
      p.term.options.macOptionIsMeta = next.optionAsAlt;
      setInstantInput(p, id, next.instantInput);
    }
    fitActive();
  };

  // Touch on the terminal. One finger scrolls, with momentum: the scrollback,
  // or (when the program reads the mouse or uses the alternate screen) the
  // program, as a mouse wheel would. Two fingers pinch the font size, saved
  // on release. Every move is ours, so the page never pulls to refresh.
  const applyRef = useRef(applyPrefs);
  applyRef.current = applyPrefs;
  useNoPullToRefresh();
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    let pinch: { dist: number; size: number } | null = null;
    let size = 0;
    // y0: where the finger went down; a drag starts scrolling only past a few pixels, so taps stay taps
    let drag: { y: number; t: number; v: number; y0: number; moving: boolean } | null = null;
    let carry = 0; // pixels short of a whole line
    let fling = 0;
    // long press: select the word under the finger, then follow it
    let hold: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null;
    let word: { start: Cell; end: Cell } | null = null;
    const cancelHold = () => {
      if (hold) clearTimeout(hold.timer);
      hold = null;
    };
    const dist = (t: TouchList) => Math.hypot(t[0]!.clientX - t[1]!.clientX, t[0]!.clientY - t[1]!.clientY);
    const scrollBy = (px: number, x: number, y: number) => {
      const term = panes.current.get(activeRef.current)?.term;
      if (!term || !px) return;
      if (term.modes.mouseTrackingMode !== "none" || term.buffer.active.type === "alternate") {
        term.element
          ?.querySelector(".xterm-screen")
          ?.dispatchEvent(new WheelEvent("wheel", { deltaY: px, deltaMode: 0, clientX: x, clientY: y, bubbles: true, cancelable: true }));
        return;
      }
      const cell = (term.element?.querySelector(".xterm-screen")?.clientHeight ?? 0) / term.rows || 16;
      carry += px;
      const lines = Math.trunc(carry / cell);
      if (lines) {
        carry -= lines * cell;
        term.scrollLines(lines);
      }
    };
    const stopFling = () => {
      if (fling) cancelAnimationFrame(fling);
      fling = 0;
    };
    const startFling = (velocity: number, x: number, y: number) => {
      let v = velocity; // px per ms
      let last = performance.now();
      const step = (now: number) => {
        const dt = Math.min(50, now - last);
        last = now;
        v *= Math.pow(0.995, dt);
        if (Math.abs(v) < 0.05) {
          fling = 0;
          return;
        }
        scrollBy(v * dt, x, y);
        fling = requestAnimationFrame(step);
      };
      fling = requestAnimationFrame(step);
    };
    // Scrolling re-renders the rows, and the row a finger started on leaves
    // the document; its touches keep going to that element only. So moves
    // and ends are followed on the elements the touches started on.
    const targets = new Set<EventTarget>();
    const follow = (t: EventTarget | null) => {
      if (!t || targets.has(t)) return;
      targets.add(t);
      t.addEventListener("touchmove", onMove as EventListener, { passive: false });
      t.addEventListener("touchend", onEnd as EventListener);
      t.addEventListener("touchcancel", onEnd as EventListener);
    };
    const unfollow = () => {
      for (const t of targets) {
        t.removeEventListener("touchmove", onMove as EventListener);
        t.removeEventListener("touchend", onEnd as EventListener);
        t.removeEventListener("touchcancel", onEnd as EventListener);
      }
      targets.clear();
    };
    const onStart = (e: TouchEvent) => {
      // only the terminal itself: forms, menus and buttons over it keep their taps
      if (!(e.target instanceof Element) || !e.target.closest(".xterm")) return;
      stopFling();
      follow(e.target);
      lastTouch.current = Date.now();
      cancelHold();
      if (e.touches.length === 1) {
        const t0 = e.touches[0]!;
        const x = t0.clientX;
        const y = t0.clientY;
        hold = {
          x,
          y,
          timer: setTimeout(() => {
            hold = null;
            const term = panes.current.get(activeRef.current)?.term;
            if (!term) return;
            drag = null;
            word = wordAt(term, cellAt(term, x, y));
            touchSelecting.current = true;
            selectBetween(term, word.start, word.end);
            setSelMenu(false);
            navigator.vibrate?.(10);
          }, LONG_PRESS_MS),
        };
      }
      if (e.touches.length === 2) {
        drag = null;
        pinch = { dist: dist(e.touches), size: prefsRef.current.fontSize };
        size = pinch.size;
      } else if (e.touches.length === 1) {
        drag = { y: e.touches[0]!.clientY, t: e.timeStamp, v: 0, y0: e.touches[0]!.clientY, moving: false };
        carry = 0;
      }
    };
    function onMove(e: TouchEvent) {
      e.stopPropagation(); // xterm would scroll as well
      if (pinch && e.touches.length === 2) {
        e.preventDefault(); // no page zoom, no scrolling while pinching
        const next = Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(pinch.size * (dist(e.touches) / pinch.dist))));
        if (next === size) return;
        size = next;
        for (const p of panes.current.values()) p.term.options.fontSize = next;
        fitActive();
        return;
      }
      if (word && e.touches.length === 1) {
        e.preventDefault();
        const term = panes.current.get(activeRef.current)?.term;
        if (!term) return;
        const t = e.touches[0]!;
        // near the top or bottom edge, scroll to select beyond the screen
        const r = areaRef.current?.getBoundingClientRect();
        if (r && t.clientY < r.top + 24) term.scrollLines(-1);
        else if (r && t.clientY > r.bottom - 24) term.scrollLines(1);
        const [a, b] = extendFrom(word, cellAt(term, t.clientX, t.clientY));
        selectBetween(term, a, b);
        return;
      }
      if (hold && e.touches.length === 1) {
        const t = e.touches[0]!;
        if (Math.hypot(t.clientX - hold.x, t.clientY - hold.y) > 10) cancelHold();
      }
      if (!drag || e.touches.length !== 1) return;
      const t = e.touches[0]!;
      if (!drag.moving) {
        if (Math.abs(t.clientY - drag.y0) < TAP_SLOP_PX) return; // still a tap: keep its click
        drag.moving = true;
        drag.y = t.clientY;
        drag.t = e.timeStamp;
        return;
      }
      e.preventDefault(); // no pull-to-refresh
      const dy = drag.y - t.clientY;
      const dt = Math.max(1, e.timeStamp - drag.t);
      drag.v = 0.8 * (dy / dt) + 0.2 * drag.v;
      drag.y = t.clientY;
      drag.t = e.timeStamp;
      scrollBy(dy, t.clientX, t.clientY);
    }
    function onEnd(e: TouchEvent) {
      e.stopPropagation();
      if (pinch && e.touches.length < 2) {
        const changed = size !== pinch.size;
        pinch = null;
        if (changed) void applyRef.current({ ...prefsRef.current, fontSize: size });
      }
      if (e.touches.length > 0) return;
      unfollow();
      cancelHold();
      if (word) {
        word = null;
        touchSelecting.current = false;
        const term = panes.current.get(activeRef.current)?.term;
        if (term?.hasSelection()) {
          if (prefsRef.current.copyOnSelect) void navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
          setSelMenu(true);
        }
        return;
      }
      if (drag) {
        const { v, t } = drag;
        drag = null;
        const p = e.changedTouches[0];
        if (e.type === "touchend" && p && e.timeStamp - t < 100 && Math.abs(v) > 0.3) startFling(v, p.clientX, p.clientY);
      }
    }
    el.addEventListener("touchstart", onStart, { passive: true, capture: true });
    return () => {
      stopFling();
      unfollow();
      cancelHold();
      el.removeEventListener("touchstart", onStart, { capture: true });
    };
  }, []);

  /** The touch selection menu. */
  const selAction = (action: "copy" | "paste" | "all" | "close") => {
    const term = panes.current.get(activeRef.current)?.term;
    if (!term) return;
    if (action === "all") {
      term.selectAll();
      return;
    }
    if (action === "copy") {
      const text = term.getSelection();
      void navigator.clipboard?.writeText(text).then(
        () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        },
        () => {},
      );
    } else if (action === "paste") {
      void navigator.clipboard
        ?.readText()
        .then((text) => {
          if (text) term.paste(text);
        })
        .catch(() => {});
    }
    term.clearSelection();
    setSelMenu(false);
  };

  /** A key from the extra keys bar: modifiers latch, the rest go to the active shell. */
  const extraKey = (id: string) => {
    const tab = activeRef.current;
    const pane = panes.current.get(tab);
    if (isModifier(id)) {
      if (id !== "meta") setSticky((s) => ({ ...s, [id]: !s[id] }));
      return;
    }
    if (id === "paste") {
      void navigator.clipboard
        ?.readText()
        .then((text) => {
          if (text) pane?.term.paste(text);
        })
        .catch(() => {});
      return;
    }
    const seq = terminalKey(id, takeSticky(), pane?.term.modes.applicationCursorKeysMode);
    if (seq !== null) sessRef.current?.write(seq, tab);
  };

  const overlay = conn !== "ready" && !ended && !choices;
  const ready = conn === "ready" && !ended;
  return (
    <div ref={rootRef} className={cn(SCOPE, "fixed inset-x-0 top-0 flex h-dvh flex-col bg-[#0a0a0a] text-white", props.className)}>
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-2 py-2">
        <Button size="icon" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" aria-label={t("toolbar.back")} title={t("toolbar.back")} onClick={leave}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <div className="min-w-0 flex-1 truncate text-sm font-medium">
          {t("terminal.title")} · {title}
        </div>
        {touch && ready && keysHidden && (
          <Button
            size="icon"
            variant="ghost"
            className="text-white hover:bg-white/10 hover:text-white"
            aria-label={t("terminal.keysShow")}
            title={t("terminal.keysShow")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setKeysHidden(false)}
          >
            <Keyboard className="h-5 w-5" />
          </Button>
        )}
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
      <div ref={areaRef} className="relative min-h-0 flex-1 p-1.5 [&_.xterm]:touch-none [&_.xterm_*]:touch-none">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            ref={(el) => {
              if (el) hosts.current.set(tab.id, el);
            }}
            className={cn("isolate h-full w-full", tab.id !== active && "hidden")}
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
        {(selMenu || copied) && ready && (
          <div
            className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-md border border-white/15 bg-neutral-900/95 p-1 text-sm text-white shadow-lg"
            role="toolbar"
            aria-label={t("terminal.selection")}
            onMouseDown={(e) => e.preventDefault()}
          >
            {copied ? (
              <span className="px-2.5 py-1.5">{t("terminal.copied")}</span>
            ) : (
              <>
                <button type="button" className="rounded px-2.5 py-1.5 hover:bg-white/10" onClick={() => selAction("copy")}>
                  {t("terminal.copy")}
                </button>
                <button type="button" className="rounded px-2.5 py-1.5 hover:bg-white/10" onClick={() => selAction("paste")}>
                  {t("terminal.paste")}
                </button>
                <button type="button" className="rounded px-2.5 py-1.5 hover:bg-white/10" onClick={() => selAction("all")}>
                  {t("terminal.selectAll")}
                </button>
                <button type="button" className="rounded p-1.5 text-white/70 hover:bg-white/10" aria-label={t("common.close")} title={t("common.close")} onClick={() => selAction("close")}>
                  <X className="h-4 w-4" />
                </button>
              </>
            )}
          </div>
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
                  remember={remember}
                  onRemember={setRemember}
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
        <ExtraKeys
          base={TERMINAL_LAYOUT.base}
          more={TERMINAL_LAYOUT.more}
          latched={new Set(Object.entries(sticky).filter(([, on]) => on).map(([m]) => m))}
          onKey={extraKey}
          label={t("terminal.keys")}
          moreLabel={t("terminal.keysMore")}
          lessLabel={t("terminal.keysLess")}
          hideHint={t("terminal.keysHide")}
          showLabel={t("terminal.keysShow")}
          stateKey={keysStateKey}
          hidden={keysHidden}
          onHiddenChange={setKeysHidden}
        />
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
            onApply({ ...draft, fontSize: Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(draft.fontSize) || 14)) });
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
              min={MIN_FONT}
              max={MAX_FONT}
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
          {isTouch() && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={draft.instantInput} onCheckedChange={(v) => setDraft({ ...draft, instantInput: v === true })} className="mt-0.5" />
              <span>
                {t("terminal.instantInput")}
                <span className="block text-xs text-muted-foreground">{t("terminal.instantInputHint")}</span>
              </span>
            </label>
          )}
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
