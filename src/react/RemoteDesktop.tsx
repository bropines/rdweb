import {
  Activity,
  Ban,
  Camera,
  Check,
  ClipboardPaste,
  Command,
  Eye,
  FolderOpen,
  Keyboard,
  LoaderCircle,
  Lock,
  Maximize2,
  MessageSquare,
  Minimize2,
  Monitor,
  MonitorUp,
  MousePointer2,
  MousePointerClick,
  RefreshCw,
  RotateCcw,
  Scaling,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Type,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import {
  Session,
  Viewer,
  isWebCodecsAvailable,
  type AudioState,
  type CloseInfo,
  type DisplayRect,
  type InputMode,
  type PeerSummary,
  type ScaleMode,
  type ServerConfig,
  type SessionSettings,
  type SessionState,
  type SessionStats,
  type UploadItem,
} from "../index.js";
import { ExtraKeys } from "./ExtraKeys.js";
import { droppedItems, FilesSheet } from "./FilesSheet.js";
import { RemoteTerminal } from "./RemoteTerminal.js";
import type { ShellStore } from "./shellStore.js";
import { I18nProvider, useI18n, type DeepPartial, type Lang, type Messages } from "./i18n/index.js";
import { cn, SCOPE } from "./lib/utils.js";
import {
  DEFAULT_STORAGE_KEY,
  hasRememberedHash,
  devicePrefsOf,
  loadDevicePrefs,
  loadPrefs,
  loadRememberedHash,
  migrateStorage,
  pushRecent,
  saveRememberedHash,
  saveDevicePrefs,
  savePrefs,
  withDevicePrefs,
  type ViewPrefs,
  type WebClientPrefs,
} from "./prefs.js";
import { DESKTOP_KEYS, desktopLayout as layoutFor, isModifier, MODIFIER_CODES, physicalKey, type Modifier } from "./keys.js";
import { screenlessPeer } from "./peerSummary.js";
import { SettingsSheet } from "./SettingsSheet.js";
import { DEFAULT_PINNED_DESKTOP, DEFAULT_PINNED_TOUCH, Toolbar, type ToolbarAction } from "./Toolbar.js";
import { useNoPullToRefresh, useVisualViewport } from "./viewport.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.js";
import { Input } from "./ui/input.js";
import { Checkbox, Textarea } from "./ui/misc.js";

/** A saved login the host found for this device (e.g. in the user's address books). */
export interface RemoteDesktopCredentials {
  /** Salted password hash, SHA256(password || salt), as stored by "remember password". */
  rememberedHash?: Uint8Array;
  /** Plain password, tried once when the device asks for one. */
  password?: string;
  /**
   * The hash belongs to the user (their personal address book): when the device
   * rejects it, or the user picks "Forget saved password", `onForget` is called
   * so the host can delete it.
   */
  fromPersonalBook?: boolean;
}

export interface RemoteDesktopProps {
  /** Device id to connect to. */
  peerId: string;
  /** hbbs/hbbr WebSocket endpoints and the server key. */
  server: ServerConfig;
  /** UI language (default "en"). */
  lang?: Lang;
  /** Overrides for single strings of the built-in catalog. */
  messages?: DeepPartial<Messages>;
  /**
   * Saved logins found by the host. Order of attempts, like the desktop client:
   * the hash remembered in this browser, then `credentials.rememberedHash`,
   * then `credentials.password`, then the password dialog.
   */
  credentials?: RemoteDesktopCredentials | null;
  /** Shown to the remote user in the connection request. */
  myName?: string;
  /** Our id as announced to the device. */
  myId?: string;
  /** Leave the session (toolbar "Back", the end-of-session overlay). */
  onLeave(): void;
  /** Reconnect after the session ended. Default: remount internally. */
  onReconnect?(): void;
  /**
   * Called after a login with "remember" ticked, with the salted hash (the
   * component also keeps it in this browser). A rejected promise shows an error toast.
   */
  onRemembered?(hash: Uint8Array): void | Promise<unknown>;
  /** The saved password should be forgotten (see `RemoteDesktopCredentials.fromPersonalBook`). */
  onForget?(): void | Promise<unknown>;
  /** The session is up (in the Files only and Terminal modes the display, codec and session fields are empty). */
  onConnected?(peer: PeerSummary): void;
  /** localStorage prefix for prefs, remembered hashes and recent devices (default "rdweb"). */
  storageKey?: string;
  /** Label of the "remember" checkbox in the password dialog. */
  rememberLabel?: string;
  /** Hint under the "remember" checkbox. */
  rememberHint?: string;
  /** Extra toolbar actions (pinnable like the built-in ones). */
  extraActions?: ToolbarAction[];
  /** Classes for the full-screen shell. */
  className?: string;
  /**
   * "desktop" (default): the remote screen. "files": only the file manager
   * (a file transfer connection, like the desktop client's "Transfer files").
   * "terminal": only a remote shell (RustDesk 1.4.1+ peers).
   */
  mode?: "desktop" | "files" | "terminal";
  /**
   * Terminal mode: where this device's kept shells are remembered for a later
   * reattach ("return to your shells"). Default: this browser's localStorage.
   */
  shellStore?: ShellStore;
}

/**
 * A full remote desktop session: video, input, floating toolbar, settings and
 * files sheets, login dialogs. Renders a fixed full-viewport shell; keep it
 * mounted for the life of the session (unmounting disconnects). Changing
 * `peerId` or the server starts a new session.
 */
export function RemoteDesktop(props: RemoteDesktopProps) {
  const [attempt, setAttempt] = useState(0);
  const { onReconnect } = props;
  const reconnect = useCallback(() => (onReconnect ? onReconnect() : setAttempt((a) => a + 1)), [onReconnect]);
  return (
    <I18nProvider lang={props.lang} messages={props.messages}>
      {props.mode === "files" ? (
        <RemoteFiles key={`${props.server.rendezvousUrl}|${props.server.key}|${props.peerId}`} {...props} />
      ) : props.mode === "terminal" ? (
        <RemoteTerminal key={`${props.server.rendezvousUrl}|${props.server.key}|${props.peerId}#${attempt}`} {...props} onReconnect={reconnect} />
      ) : isWebCodecsAvailable() ? (
        <RemoteSession key={`${props.server.rendezvousUrl}|${props.server.key}|${props.peerId}#${attempt}`} {...props} onReconnect={reconnect} />
      ) : (
        <Unsupported onLeave={props.onLeave} className={props.className} />
      )}
    </I18nProvider>
  );
}

/** File manager only: a file transfer connection, no screen. */
function RemoteFiles(props: RemoteDesktopProps) {
  const storageKey = props.storageKey ?? DEFAULT_STORAGE_KEY;
  const [hash] = useState(() => loadRememberedHash(props.server.key, props.peerId, storageKey) ?? props.credentials?.rememberedHash ?? null);
  return (
    <div className={cn(SCOPE, "fixed inset-0 bg-background text-foreground", props.className)}>
      <FilesSheet
        inline
        open
        onOpenChange={() => {}}
        peerId={props.peerId}
        server={props.server}
        rememberedHash={hash}
        myName={props.myName}
        myId={props.myId || undefined}
        onBack={props.onLeave}
        title={props.peerId}
        storageKey={storageKey}
        onConnected={(peer) => {
          pushRecent(props.peerId, peer.hostname || undefined, storageKey);
          props.onConnected?.(screenlessPeer(peer));
        }}
        onRemembered={(hash) => props.onRemembered?.(hash)}
      />
    </div>
  );
}

function Unsupported({ onLeave, className }: { onLeave: () => void; className?: string }) {
  const { t } = useI18n();
  return (
    <div className={cn(SCOPE, "fixed inset-0 flex items-center justify-center bg-background p-4 text-foreground", className)}>
      <div className="w-full max-w-sm space-y-4 rounded-lg border bg-card p-6 text-center text-card-foreground shadow-sm">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <h1 className="text-lg font-semibold">{t("unsupportedTitle")}</h1>
        <p className="text-sm text-muted-foreground">{t("unsupportedDesc")}</p>
        <Button variant="outline" onClick={onLeave}>
          {t("common.back")}
        </Button>
      </div>
    </div>
  );
}

function isTouchFirst(): boolean {
  return !!window.matchMedia?.("(pointer: coarse)").matches && !window.matchMedia?.("(pointer: fine)").matches;
}

function swallow(fn: (() => void | Promise<unknown>) | undefined): void {
  try {
    void Promise.resolve(fn?.()).catch(() => {});
  } catch {
    /* host callback failed */
  }
}

/** Runs a host callback; a throw or rejected promise reports `onError`. */
function settle(result: () => void | Promise<unknown>, onOk: () => void, onError: () => void): void {
  let p: Promise<unknown>;
  try {
    p = Promise.resolve(result());
  } catch {
    onError();
    return;
  }
  p.then(onOk, onError);
}

/* ───────────────────────────── session ───────────────────────────── */

type DialogName = "none" | "password" | "twoFactor" | "clipboard" | "type" | "chat" | "restart" | "display";

const KNOWN_ERRORS = ["offline", "not-found", "key-mismatch", "login-required", "timeout", "network", "unreachable", "handshake", "unverified-peer", "refused"];

function RemoteSession(props: RemoteDesktopProps & { onReconnect: () => void }) {
  const { peerId, credentials, onLeave, onReconnect } = props;
  const storageKey = props.storageKey ?? DEFAULT_STORAGE_KEY;
  // fixed for the life of this component (it is keyed by peer and server)
  const [server] = useState(props.server);
  const { t } = useI18n();
  // host callbacks may change between renders; the session handlers read the latest
  const cb = useRef(props);
  useEffect(() => {
    cb.current = props;
  });
  const screenRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<Session | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const rememberRef = useRef(false);
  const [loginHash, setLoginHash] = useState<Uint8Array | null>(null);

  // the defaults with this device's own settings on top
  const [prefs, setPrefs] = useState<WebClientPrefs>(() => {
    migrateStorage(storageKey);
    return withDevicePrefs(loadPrefs(storageKey), loadDevicePrefs(server.key, peerId, storageKey));
  });
  const [state, setState] = useState<SessionState>("idle");
  const [peer, setPeer] = useState<PeerSummary | null>(null);
  const [currentDisplay, setCurrentDisplay] = useState(0);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [closed, setClosed] = useState<CloseInfo | null>(null);
  const [error, setError] = useState<string>("");
  const [dialog, setDialog] = useState<DialogName>("none");
  const [pwWrong, setPwWrong] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [tfaWrong, setTfaWrong] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [incoming, setIncoming] = useState<UploadItem[] | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [keyboardBar, setKeyboardBar] = useState(false);
  // Ctrl / Alt / Win / Shift from the extra keys bar, pressed with the next key
  const [sticky, setSticky] = useState<ReadonlySet<Modifier>>(new Set());
  const stickyRef = useRef(sticky);
  stickyRef.current = sticky;
  const [resolution, setResolution] = useState("current");
  const [privacyOn, setPrivacyOn] = useState(false);
  const [blockOn, setBlockOn] = useState(false);
  const [permKeyboard, setPermKeyboard] = useState(true);
  const [hasSaved, setHasSaved] = useState(() => hasRememberedHash(server.key, peerId, storageKey));
  const [hostHashForgotten, setHostHashForgotten] = useState(false);
  const [audioState, setAudioState] = useState<AudioState>("off");
  const inputMode: InputMode = prefs.view.inputMode ?? (isTouchFirst() ? "trackpad" : "mouse");
  const touch = inputMode !== "mouse";

  // Session + viewer lifecycle
  useEffect(() => {
    const el = screenRef.current;
    if (!el) return;
    const p = withDevicePrefs(loadPrefs(storageKey), loadDevicePrefs(server.key, peerId, storageKey));
    // Saved logins, in the desktop client's order: this browser's remembered
    // hash, the host's hash (personal address book), then the host's password.
    const localHash = loadRememberedHash(server.key, peerId, storageKey);
    const hostHash = localHash ? undefined : credentials?.rememberedHash;
    let hostPasswordTried = !credentials?.password;
    let session: Session;
    try {
      session = new Session({
        peerId,
        server,
        rememberedHash: localHash ?? hostHash,
        myName: props.myName,
        myId: props.myId || undefined,
        settings: p.settings,
      });
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    const viewer = new Viewer(el, session, {
      scaleMode: p.view.scaleMode,
      inputMode: p.view.inputMode ?? undefined,
      zoomCursor: p.view.zoomCursor,
    });
    sessionRef.current = session;
    viewerRef.current = viewer;
    // a latched Ctrl / Alt / Win goes with the next key typed on the phone keyboard
    viewer.setSoftKeyHandler((input) => {
      if (!stickyRef.current.size) return false;
      const k = typeof input === "string" ? physicalKey(input) : input;
      if (!k) return false;
      pressSpecial(k.code, k.key);
      return true;
    });
    setAudioState(session.audioState);
    let audioBlockedShown = false;
    const forgetLocal = () => {
      saveRememberedHash(server.key, peerId, null, storageKey);
      setHasSaved(false);
    };
    const offs = [
      session.on("state", ({ state }) => setState(state)),
      session.on("password", ({ wrong }) => {
        if (!hostPasswordTried && credentials?.password) {
          hostPasswordTried = true;
          if (wrong && localHash) forgetLocal();
          void session.login(credentials.password);
          return;
        }
        setPwWrong(wrong);
        if (wrong && localHash) forgetLocal();
        if (wrong && hostHash && credentials?.fromPersonalBook) {
          setHostHashForgotten(true);
          swallow(cb.current.onForget);
        }
        setDialog("password");
      }),
      session.on("waitingForApproval", () => {
        setWaiting(true);
        setDialog("password");
      }),
      session.on("twoFactor", ({ wrong }) => {
        setTfaWrong(wrong);
        setDialog("twoFactor");
      }),
      session.on("connected", ({ peer, rememberedHash }) => {
        setLoginHash(rememberedHash);
        setPeer(peer);
        setCurrentDisplay(peer.currentDisplay);
        setDialog("none");
        setWaiting(false);
        pushRecent(peerId, peer.hostname || undefined, storageKey);
        if (rememberedHash && rememberRef.current) {
          saveRememberedHash(server.key, peerId, rememberedHash, storageKey);
          setHasSaved(true);
          const onRemembered = cb.current.onRemembered;
          if (onRemembered) settle(() => onRemembered(rememberedHash), () => {}, () => toast.error(t("rememberAccountFailed")));
        }
        viewer.focus();
        try {
          cb.current.onConnected?.(peer);
        } catch {
          /* host callback failed */
        }
      }),
      session.on("peer", ({ peer }) => setPeer(peer)),
      session.on("display", ({ display }) => setCurrentDisplay(display.index)),
      session.on("stats", setStats),
      session.on("audio", ({ state }) => {
        setAudioState(state);
        // browsers block autoplay until a user gesture: say so once per session
        if (state !== "blocked" || audioBlockedShown) return;
        audioBlockedShown = true;
        toast(t("audioBlocked"), { action: { label: t("enableSound"), onClick: () => session.resumeAudio() } });
      }),
      session.on("permission", ({ name, enabled }) => {
        if (name === "keyboard") setPermKeyboard(enabled);
      }),
      session.on("privacyMode", ({ on, message }) => {
        setPrivacyOn(on);
        if (message) toast.info(message);
      }),
      session.on("blockInput", ({ on, message }) => {
        setBlockOn(on);
        if (message) toast.info(message);
      }),
      session.on("message", ({ type, title, text }) => {
        const body = [title, text].filter(Boolean).join(": ");
        if (!body) return;
        if (type.includes("error")) toast.error(body);
        else toast.info(body);
      }),
      session.on("chat", ({ text }) => toast(t("chatFromRemote"), { description: text, duration: 10_000 })),
      session.on("close", (info) => {
        setClosed(info);
        setDialog("none");
      }),
      viewer.on("files", ({ dataTransfer }) => {
        if (sessionRef.current?.permission.file === false) {
          toast.error(t("files.errors.permission-denied"));
          return;
        }
        void droppedItems(dataTransfer).then((items) => {
          if (!items.length) return;
          setIncoming(items);
          setFilesOpen(true);
        });
      }),
      viewer.on("clipboardBlocked", ({ text }) =>
        toast(t("clipboardReceived"), {
          action: { label: t("copy"), onClick: () => void navigator.clipboard.writeText(text).catch(() => {}) },
        }),
      ),
    ];
    let disposed = false;
    session.connect().catch((e: Error & { code?: string }) => {
      if (disposed) return;
      setError(e.code && KNOWN_ERRORS.includes(e.code) ? t(`errors.${e.code}`, { detail: e.message }) : e.message);
    });
    return () => {
      disposed = true;
      for (const off of offs) off();
      session.close("closed");
      viewer.destroy();
      sessionRef.current = null;
      viewerRef.current = null;
    };
    // peer, server and credentials are fixed for the life of this component (it is keyed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist: what a session changes in the connection settings belongs to this
  // device; the defaults stay; view (other than the scale) and toolbar are global.
  useEffect(() => {
    const defaults = loadPrefs(storageKey);
    savePrefs({ settings: defaults.settings, view: { ...prefs.view, scaleMode: defaults.view.scaleMode }, toolbar: prefs.toolbar }, storageKey);
    saveDevicePrefs(server.key, peerId, devicePrefsOf(defaults, prefs), storageKey);
  }, [prefs, storageKey, server.key, peerId]);
  const ownSettings = Object.keys(devicePrefsOf(loadPrefs(storageKey), prefs)).length > 0;

  // Follow the effective input mode (it depends on the device when unset).
  useEffect(() => {
    if (viewerRef.current && viewerRef.current.getInputMode() !== inputMode) viewerRef.current.setInputMode(inputMode);
  }, [inputMode]);

  // Keep the screen above on-screen keyboards, and the page from reloading on a swipe down.
  useVisualViewport(shellRef);
  useNoPullToRefresh();

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const updateSettings = useCallback((patch: Partial<SessionSettings>) => {
    sessionRef.current?.updateSettings(patch);
    setPrefs((p) => ({ ...p, settings: { ...p.settings, ...patch } }));
  }, []);

  /** Back to the default connection settings for this device. */
  const resetToDefaults = () => {
    const d = loadPrefs(storageKey);
    const settings = { ...d.settings, viewOnly: prefs.settings.viewOnly };
    sessionRef.current?.updateSettings(settings);
    viewerRef.current?.setScaleMode(d.view.scaleMode);
    setPrefs((p) => ({ ...p, settings: { ...settings, viewOnly: p.settings.viewOnly }, view: { ...p.view, scaleMode: d.view.scaleMode } }));
  };

  const updateView = useCallback((patch: Partial<ViewPrefs>) => {
    const v = viewerRef.current;
    if (v) {
      if (patch.scaleMode) v.setScaleMode(patch.scaleMode);
      if (patch.inputMode) v.setInputMode(patch.inputMode);
      if (patch.zoomCursor !== undefined) v.setZoomCursor(patch.zoomCursor);
    }
    setPrefs((p) => ({ ...p, view: { ...p.view, ...patch } }));
  }, []);

  const s = sessionRef.current;
  const connected = state === "connected";
  const busy = !closed && !error && !connected;

  /** Presses a key with the latched modifiers, then releases them. */
  const pressSpecial = (code: string, key: string) => {
    const sess = sessionRef.current;
    if (!sess) return;
    const mods = [...stickyRef.current].map((m) => MODIFIER_CODES[m]);
    for (const m of mods) sess.key({ code: m, key: "", down: true });
    sess.key({ code, key, down: true });
    sess.key({ code, key, down: false });
    for (const m of mods.reverse()) sess.key({ code: m, key: "", down: false });
    if (mods.length) {
      stickyRef.current = new Set();
      setSticky(stickyRef.current);
    }
  };

  const extraKey = (id: string) => {
    if (isModifier(id)) {
      setSticky((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      return;
    }
    const k = DESKTOP_KEYS[id];
    if (k) pressSpecial(k.code, k.key);
  };

  // Our own disconnects are not worth a raw (English) reason.
  const closedText = closed ? (closed.remote ? closed.reason : t("state.closed")) : "";
  const statusText = error ? error : closed ? closedText : t(`state.${state}`, { defaultValue: state });

  const title = peer?.hostname || peerId;
  const desktopLayout = layoutFor(peer?.os);

  const displays = peer?.displays ?? [];
  const screenshot = () =>
    void viewerRef.current?.screenshot().then((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${peerId}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  const nextScale: Record<ScaleMode, ScaleMode> = { fit: "original", original: "stretch", stretch: "fit" };
  const nextInput: Record<InputMode, InputMode> = { mouse: "trackpad", trackpad: "touch", touch: "mouse" };
  const off = !connected;
  const st = prefs.settings;
  const hostHashSaved = !!credentials?.rememberedHash && !!credentials.fromPersonalBook && !hostHashForgotten;
  const actions: ToolbarAction[] = [
    // the browser blocks audio until a user gesture: offer one on the bar
    { id: "sound", label: t("enableSound"), icon: VolumeX, hidden: audioState !== "blocked", forcePinned: true, run: () => s?.resumeAudio() },
    { id: "settings", label: t("settings.title"), icon: Settings2, disabled: off, run: () => setSettingsOpen(true) },
    { id: "files", label: t("files.title"), icon: FolderOpen, disabled: off || s?.permission.file === false, run: () => setFilesOpen(true) },
    {
      id: "keyboard",
      label: t("keyboard.show"),
      icon: Keyboard,
      hidden: !touch,
      active: keyboardBar,
      disabled: off,
      run: () => {
        setKeyboardBar((v) => !v);
        if (!keyboardBar) viewerRef.current?.showKeyboard();
        else viewerRef.current?.hideKeyboard();
      },
    },
    { id: "inputMode", label: `${t("settings.inputMode")}: ${t(`input.${inputMode}`)}`, icon: MousePointer2, disabled: off, run: () => updateView({ inputMode: nextInput[inputMode] }) },
    { id: "viewMode", label: `${t("settings.viewStyle")}: ${t(`view.${prefs.view.scaleMode}`)}`, icon: Scaling, disabled: off, run: () => updateView({ scaleMode: nextScale[prefs.view.scaleMode] }) },
    {
      id: "display",
      label: t("toolbar.display", { n: currentDisplay + 1, total: displays.length }),
      icon: Monitor,
      hidden: displays.length < 2,
      disabled: off,
      run: () => setDialog("display"),
    },
    {
      id: "nextDisplay",
      label: t("toolbar.nextDisplay", { n: currentDisplay + 1, total: displays.length }),
      icon: MonitorUp,
      hidden: displays.length < 2,
      disabled: off,
      run: () => s?.switchDisplay((currentDisplay + 1) % Math.max(1, displays.length)),
    },
    { id: "ctrlAltDel", label: t("ctrlAltDel"), icon: Command, disabled: off || !permKeyboard || st.viewOnly, run: () => s?.ctrlAltDel() },
    { id: "lockScreen", label: t("lockScreen"), icon: Lock, disabled: off || !permKeyboard || st.viewOnly, run: () => s?.lockScreen() },
    { id: "refresh", label: t("refresh"), icon: RefreshCw, disabled: off, run: () => s?.refreshVideo() },
    { id: "mute", label: t("settings.mute"), icon: st.disableAudio ? VolumeX : Volume2, active: st.disableAudio, disabled: off, run: () => updateSettings({ disableAudio: !st.disableAudio }) },
    { id: "viewOnly", label: t("settings.viewOnly"), icon: Eye, active: st.viewOnly, disabled: off, run: () => updateSettings({ viewOnly: !st.viewOnly }) },
    { id: "remoteCursor", label: t("settings.showRemoteCursor"), icon: MousePointerClick, active: st.showRemoteCursor, disabled: off, run: () => updateSettings({ showRemoteCursor: !st.showRemoteCursor }) },
    { id: "stats", label: t("settings.showStats"), icon: Activity, active: prefs.view.showStats, disabled: off, run: () => updateView({ showStats: !prefs.view.showStats }) },
    { id: "clipboard", label: t("sendClipboard"), icon: ClipboardPaste, disabled: off || !permKeyboard || st.viewOnly, run: () => setDialog("clipboard") },
    { id: "typeText", label: t("typeText"), icon: Type, disabled: off || !permKeyboard || st.viewOnly, run: () => setDialog("type") },
    { id: "chat", label: t("chat"), icon: MessageSquare, disabled: off, run: () => setDialog("chat") },
    { id: "screenshot", label: t("screenshot"), icon: Camera, disabled: off, run: screenshot },
    {
      id: "privacy",
      label: t("settings.privacyMode"),
      icon: ShieldCheck,
      hidden: !peer?.privacyModeSupported || s?.permission.privacyMode === false,
      active: privacyOn,
      disabled: off,
      run: () => s?.setPrivacyMode(!privacyOn),
    },
    {
      id: "blockInput",
      label: t("settings.blockInput"),
      icon: Ban,
      hidden: peer?.os !== "windows" || s?.permission.blockInput === false,
      active: blockOn,
      disabled: off,
      run: () => {
        setBlockOn(!blockOn);
        s?.setBlockInput(!blockOn);
      },
    },
    {
      id: "fullscreen",
      label: fullscreen ? t("exitFullscreen") : t("fullscreen"),
      icon: fullscreen ? Minimize2 : Maximize2,
      hidden: !document.fullscreenEnabled,
      active: fullscreen,
      run: () => (fullscreen ? void viewerRef.current?.exitFullscreen() : void viewerRef.current?.enterFullscreen(shellRef.current ?? undefined)),
    },
    ...(props.extraActions ?? []),
    {
      id: "forgetPassword",
      label: t("forgetPassword"),
      icon: Trash2,
      hidden: !hasSaved && !hostHashSaved,
      run: () => {
        saveRememberedHash(server.key, peerId, null, storageKey);
        setHasSaved(false);
        const onForget = cb.current.onForget;
        if (!onForget) {
          toast.success(t("passwordCleared"));
          return;
        }
        settle(
          onForget,
          () => {
            setHostHashForgotten(true);
            toast.success(t("passwordCleared"));
          },
          () => toast.error(t("rememberAccountFailed")),
        );
      },
    },
    { id: "restart", label: t("restartRemote"), icon: RotateCcw, danger: true, hidden: s?.permission.restart === false, disabled: off, run: () => setDialog("restart") },
  ];
  const defaultPinned = touch ? DEFAULT_PINNED_TOUCH : DEFAULT_PINNED_DESKTOP;
  const pinned = prefs.toolbar.pinned ?? defaultPinned;

  return (
    <div ref={shellRef} className={cn(SCOPE, "fixed inset-x-0 top-0 flex h-dvh flex-col overflow-hidden bg-black text-white", props.className)}>
      {/* the floating toolbar overlays the screen (positioned in the screen box below) */}
      {/* screen */}
      <div className="relative min-h-0 flex-1">
        <div ref={screenRef} className="absolute inset-0" />
        <Toolbar
          actions={actions}
          pinned={pinned}
          onPinned={(ids) => setPrefs((p) => ({ ...p, toolbar: { ...p.toolbar, pinned: ids } }))}
          defaultPinned={defaultPinned}
          keepOpen={prefs.toolbar.keepOpen}
          onKeepOpen={(v) => setPrefs((p) => ({ ...p, toolbar: { ...p.toolbar, keepOpen: v } }))}
          position={prefs.toolbar.position}
          onPosition={(x) => setPrefs((p) => ({ ...p, toolbar: { ...p.toolbar, position: x } }))}
          title={title}
          subtitle={connected && peer ? `${peerId} · ${peer.platform}` : statusText}
          status={connected ? "ok" : closed || error ? "error" : "busy"}
          onStatus={connected ? () => setInfoOpen(true) : undefined}
          touch={touch}
          canCollapse={connected && !settingsOpen && !filesOpen && dialog === "none"}
          onDisconnect={() => s?.close()}
          onLeave={onLeave}
          ended={!!(closed || error)}
        />

        <ConnectionInfo open={infoOpen && connected} onOpenChange={setInfoOpen} session={s} peer={peer} stats={stats} />
        {prefs.view.showStats && stats && connected && (
          <div className="pointer-events-none absolute left-2 top-2 rounded bg-black/70 px-2 py-1 font-mono text-[11px] leading-snug text-white/90">
            <div>
              {(stats.codec ?? "—").toUpperCase()}
              {stats.chroma444 ? " 4:4:4" : ""} · {stats.width}×{stats.height}
            </div>
            <div>
              {stats.fps} fps · {stats.kbps} kbps
            </div>
            <div>
              {t("stats.delay")} {stats.delayMs} ms · {t("stats.target")} {stats.targetKbps} kbps
            </div>
          </div>
        )}
        {busy && dialog === "none" && (
          <Overlay>
            <LoaderCircle className="h-6 w-6 animate-spin" />
            <div className="text-sm text-white/80">{statusText}</div>
          </Overlay>
        )}
        {(closed || error) && (
          <Overlay>
            <div className="max-w-sm text-center text-sm text-white/90">{error || closedText}</div>
            <div className="flex flex-wrap justify-center gap-2">
              <Button size="sm" onClick={onReconnect}>
                <RefreshCw className="mr-2 h-4 w-4" />
                {t("reconnect")}
              </Button>
              <Button size="sm" variant="secondary" onClick={onLeave}>
                {t("common.back")}
              </Button>
            </div>
          </Overlay>
        )}
      </div>

      {/* extra keys for on-screen keyboards */}
      {connected && touch && keyboardBar && (
        <ExtraKeys
          base={desktopLayout.base}
          more={desktopLayout.more}
          latched={sticky}
          onKey={extraKey}
          label={t("keys.bar")}
          moreLabel={t("keys.more")}
          lessLabel={t("keys.less")}
          hideHint={t("keys.hide")}
          showLabel={t("keys.show")}
          stateKey={`${storageKey}.keys`}
        />
      )}

      <FilesSheet
        open={filesOpen}
        onOpenChange={setFilesOpen}
        peerId={peerId}
        server={server}
        rememberedHash={loginHash}
        myName={props.myName}
        myId={props.myId || undefined}
        incoming={incoming}
        onIncomingDone={() => setIncoming(null)}
        storageKey={storageKey}
      />
      <SettingsSheet
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={prefs.settings}
        onSettings={updateSettings}
        ownSettings={ownSettings}
        onResetSettings={resetToDefaults}
        view={prefs.view}
        inputMode={inputMode}
        onView={updateView}
        peer={peer}
        currentDisplay={currentDisplay}
        onSwitchDisplay={(i) => s?.switchDisplay(i)}
        resolution={resolution}
        onResolution={(v) => {
          setResolution(v);
          if (v === "current") return;
          const [w, h] = v.split("x").map(Number);
          s?.changeResolution(w ?? 0, h ?? 0);
        }}
        privacyOn={privacyOn}
        onPrivacy={(on) => s?.setPrivacyMode(on)}
        blockInputOn={blockOn}
        onBlockInput={(on) => {
          setBlockOn(on);
          s?.setBlockInput(on);
        }}
        canPrivacy={!!peer?.privacyModeSupported && s?.permission.privacyMode !== false}
        canBlockInput={peer?.os === "windows" && s?.permission.blockInput !== false}
      />

      <PasswordDialog
        open={dialog === "password"}
        wrong={pwWrong}
        waiting={waiting}
        rememberLabel={props.rememberLabel ?? t("rememberPassword")}
        rememberHint={props.rememberHint ?? t("rememberHint")}
        onSubmit={(pw, remember) => {
          rememberRef.current = remember;
          setPwWrong(false);
          void sessionRef.current?.login(pw);
        }}
        onCancel={() => {
          setDialog("none");
          sessionRef.current?.close(t("cancelled"));
        }}
      />
      <TwoFactorDialog
        open={dialog === "twoFactor"}
        wrong={tfaWrong}
        onSubmit={(code) => {
          setTfaWrong(false);
          sessionRef.current?.submitTwoFactor(code);
        }}
        onCancel={() => {
          setDialog("none");
          sessionRef.current?.close(t("cancelled"));
        }}
      />
      <TextDialog
        open={dialog === "clipboard"}
        title={t("sendClipboard")}
        description={t("sendClipboardDesc")}
        submitLabel={t("send")}
        onSubmit={(text) => {
          s?.sendClipboard(text);
          toast.success(t("clipboardSent"));
        }}
        onClose={() => setDialog("none")}
      />
      <TextDialog
        open={dialog === "type"}
        title={t("typeText")}
        description={t("typeTextDesc")}
        submitLabel={t("type")}
        onSubmit={(text) => s?.typeText(text)}
        onClose={() => setDialog("none")}
      />
      <TextDialog
        open={dialog === "chat"}
        title={t("chat")}
        description={t("chatDesc")}
        submitLabel={t("send")}
        onSubmit={(text) => s?.sendChat(text)}
        onClose={() => setDialog("none")}
      />
      <Dialog open={dialog === "display"} onOpenChange={(o) => !o && setDialog("none")}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md" closeLabel={t("common.close")}>
          <DialogHeader>
            <DialogTitle>{t("settings.monitor")}</DialogTitle>
            <DialogDescription>{t("toolbar.displayPick")}</DialogDescription>
          </DialogHeader>
          <div role="listbox" aria-label={t("settings.monitor")} className="flex flex-col gap-1">
            {displays.map((d) => {
              const current = d.index === currentDisplay;
              return (
                <Button
                  key={d.index}
                  role="option"
                  aria-selected={current}
                  variant={current ? "secondary" : "ghost"}
                  className="h-auto justify-start gap-2 whitespace-normal py-2 text-left"
                  onClick={() => {
                    // the monitor already on screen: nothing to switch (it would only reset the video)
                    if (!current) s?.switchDisplay(d.index);
                    setDialog("none");
                  }}
                >
                  <Monitor className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1 break-words">{displayLabel(d)}</span>
                  {current && <Check className="h-4 w-4 shrink-0" aria-hidden />}
                </Button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={dialog === "restart"} onOpenChange={(o) => !o && setDialog("none")}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md" closeLabel={t("common.close")}>
          <DialogHeader>
            <DialogTitle>{t("restartRemote")}</DialogTitle>
            <DialogDescription>{t("restartConfirm")}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDialog("none")}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                s?.restartRemote();
                setDialog("none");
              }}
            >
              {t("restartRemote")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** "2 · DISPLAY2 (1920×1080)": Windows peers name monitors `\\.\DISPLAY2`, the prefix is dropped. */
function displayLabel(d: DisplayRect): string {
  const name = d.name.replace(/^\\\\\.\\/, "");
  return `${d.index + 1}${name ? ` · ${name}` : ""} (${d.width}×${d.height})`;
}

function Overlay({ children }: { children: ReactNode }) {
  return <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60 p-4">{children}</div>;
}

function PasswordDialog({
  open,
  wrong,
  waiting,
  rememberLabel,
  rememberHint,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  wrong: boolean;
  waiting: boolean;
  rememberLabel: string;
  rememberHint: string;
  onSubmit: (pw: string, remember: boolean) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [pw, setPw] = useState("");
  const [remember, setRemember] = useState(false);
  const [sent, setSent] = useState(false);
  useEffect(() => {
    if (open) setSent(false);
  }, [open, wrong]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md" closeLabel={t("common.close")}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!pw) return;
            setSent(true);
            onSubmit(pw, remember);
            setPw("");
          }}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>{t("passwordRequired")}</DialogTitle>
            <DialogDescription>{waiting ? t("waitingForApproval") : t("passwordDesc")}</DialogDescription>
          </DialogHeader>
          {wrong && <p className="text-sm text-destructive">{t("wrongPassword")}</p>}
          <Input
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder={t("passwordPlaceholder")}
            autoComplete="off"
            autoFocus
            aria-label={t("passwordPlaceholder")}
          />
          <label className="flex items-start gap-2 text-sm">
            <Checkbox className="mt-0.5" checked={remember} onCheckedChange={(v) => setRemember(v === true)} aria-label={rememberLabel} />
            <span>
              {rememberLabel}
              {rememberHint && <span className="block text-xs text-muted-foreground">{rememberHint}</span>}
            </span>
          </label>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={onCancel}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!pw || sent}>
              {sent ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
              {t("connect")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TwoFactorDialog({ open, wrong, onSubmit, onCancel }: { open: boolean; wrong: boolean; onSubmit: (code: string) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-sm" closeLabel={t("common.close")}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim()) onSubmit(code.trim());
            setCode("");
          }}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>{t("twoFactorTitle")}</DialogTitle>
            <DialogDescription>{t("twoFactorDesc")}</DialogDescription>
          </DialogHeader>
          {wrong && <p className="text-sm text-destructive">{t("twoFactorWrong")}</p>}
          <Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={10} aria-label={t("twoFactorTitle")} />
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={onCancel}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!code.trim()}>
              {t("verify")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TextDialog({
  open,
  title,
  description,
  submitLabel,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  submitLabel: string;
  onSubmit: (text: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md" closeLabel={t("common.close")}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} autoFocus aria-label={title} />
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!text}
            onClick={() => {
              onSubmit(text);
              setText("");
              onClose();
            }}
          >
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Connection details, like the desktop client's connection indicator. */
function ConnectionInfo({
  open,
  onOpenChange,
  session,
  peer,
  stats,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  session: Session | null | undefined;
  peer: PeerSummary | null;
  stats: SessionStats | null;
}) {
  const { t } = useI18n();
  const c = session?.connection;
  const host = (u: string | undefined) => {
    try {
      return u ? new URL(u).host : "—";
    } catch {
      return "—";
    }
  };
  const rows: [string, string][] = [
    [t("info.device"), peer ? [peer.hostname, peer.platform, peer.version && `RustDesk ${peer.version}`].filter(Boolean).join(" · ") : "—"],
    [t("info.route"), c?.tls ? t("info.relayTls") : t("info.relayPlain")],
    [t("info.relay"), host(c?.relayUrl)],
    [t("info.idServer"), host(c?.rendezvousUrl)],
    [t("info.encryption"), t("info.e2e")],
    [
      t("info.video"),
      stats?.codec ? `${stats.codec.toUpperCase()}${stats.chroma444 ? " 4:4:4" : ""} · ${stats.width}×${stats.height} · ${stats.fps} fps · ${stats.kbps} kbps` : "—",
    ],
    [t("info.delay"), stats ? `${stats.delayMs} ms` : "—"],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(SCOPE, "max-w-[calc(100vw-2rem)] sm:max-w-md")} closeLabel={t("common.close")}>
        <DialogHeader>
          <DialogTitle>{t("info.title")}</DialogTitle>
          <DialogDescription>{t("info.desc")}</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="min-w-0 break-words font-medium">{v}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
