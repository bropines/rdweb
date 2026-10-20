import { ChevronLeft, RefreshCw, Settings2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
import { XTERM_CSS } from "./xtermCss.js";

const KNOWN_ERRORS = ["offline", "not-found", "key-mismatch", "login-required", "timeout", "network", "unreachable", "handshake", "unverified-peer", "refused"];

/** Keys a phone keyboard lacks, as terminal input. */
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
}

const DEFAULT_TERMINAL_PREFS: TerminalPrefs = { fontFamily: "", fontSize: 14, nerdSymbols: true };

function loadTerminalPrefs(storageKey: string): TerminalPrefs {
  try {
    const raw = localStorage.getItem(`${storageKey}.terminal`);
    const v = raw ? (JSON.parse(raw) as Partial<TerminalPrefs>) : {};
    return {
      fontFamily: typeof v.fontFamily === "string" ? v.fontFamily.slice(0, 100) : "",
      fontSize: typeof v.fontSize === "number" && v.fontSize >= 8 && v.fontSize <= 32 ? v.fontSize : 14,
      nerdSymbols: v.nerdSymbols !== false,
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
  style.textContent = XTERM_CSS;
  document.head.appendChild(style);
}

/** A remote shell only (RustDesk "Terminal"), full screen. */
export function RemoteTerminal(props: RemoteDesktopProps & { onReconnect: () => void }) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const sessRef = useRef<TerminalSession | null>(null);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [error, setError] = useState("");
  const [wrong, setWrong] = useState(false);
  const [secret, setSecret] = useState("");
  const [ended, setEnded] = useState<string | null>(null);
  const [title, setTitle] = useState(props.peerId);
  const storageKeyRef = useRef(props.storageKey ?? DEFAULT_STORAGE_KEY);
  const [prefs, setPrefs] = useState<TerminalPrefs>(() => loadTerminalPrefs(storageKeyRef.current));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const termRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitRef = useRef<{ fit(): void } | null>(null);
  const touch = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    let disposed = false;
    let ro: ResizeObserver | null = null;
    let term: import("@xterm/xterm").Terminal | null = null;
    let opened = false;
    const storageKey = props.storageKey ?? DEFAULT_STORAGE_KEY;
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      const initial = loadTerminalPrefs(storageKey);
      if (initial.nerdSymbols) await loadNerdSymbols();
      if (disposed) return;
      injectXtermCss();
      term = new Terminal({
        cursorBlink: true,
        fontFamily: fontStack(initial),
        fontSize: initial.fontSize,
        scrollback: 5000,
        theme: { background: "#0a0a0a" },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      fit.fit();
      termRef.current = term;
      fitRef.current = fit;
      const s = new TerminalSession({
        peerId: props.peerId,
        server: props.server,
        rememberedHash: loadRememberedHash(props.server.key, props.peerId, storageKey) ?? props.credentials?.rememberedHash,
        myName: props.myName,
        myId: props.myId || undefined,
        cols: term.cols,
        rows: term.rows,
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
      s.on("data", ({ data }) => term?.write(data));
      s.on("close", (info) => {
        // before the shell opened, connect() rejects and shows the error instead
        if (!disposed && opened) setEnded(info.reason);
      });
      term.onData((d) => s.write(d));
      ro = new ResizeObserver(() => {
        try {
          fit.fit();
          if (term) s.resize(term.cols, term.rows);
        } catch {
          /* hidden or detached */
        }
      });
      ro.observe(el);
      await s.connect();
      opened = true;
      if (disposed) return;
      const p = s.peer;
      if (p) setTitle(p.hostname ? `${p.hostname} · ${props.peerId}` : props.peerId);
      setConn("ready");
      term.focus();
    })().catch((e: Error & { code?: string }) => {
      if (disposed) return;
      setError(e.code && KNOWN_ERRORS.includes(e.code) ? t(`errors.${e.code}`, { detail: e.message }) : e.message);
      setConn("error");
    });
    return () => {
      disposed = true;
      ro?.disconnect();
      sessRef.current?.close("closed");
      sessRef.current = null;
      term?.dispose();
    };
    // one session per mount; the host remounts to reconnect
  }, []);

  const applyPrefs = async (next: TerminalPrefs) => {
    setPrefs(next);
    saveTerminalPrefs(storageKeyRef.current, next);
    if (next.nerdSymbols) await loadNerdSymbols();
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = fontStack(next);
    term.options.fontSize = next.fontSize;
    try {
      fitRef.current?.fit();
      sessRef.current?.resize(term.cols, term.rows);
    } catch {
      /* not attached */
    }
  };

  const overlay = conn !== "ready" && !ended;
  return (
    <div className={cn(SCOPE, "fixed inset-0 flex flex-col bg-[#0a0a0a] text-white", props.className)}>
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-2 py-2">
        <Button size="icon" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" aria-label={t("toolbar.back")} title={t("toolbar.back")} onClick={props.onLeave}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <div className="min-w-0 flex-1 truncate text-sm font-medium">
          {t("terminal.title")} · {title}
        </div>
        <Button size="icon" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" aria-label={t("terminal.settings")} title={t("terminal.settings")} onClick={() => setSettingsOpen(true)}>
          <Settings2 className="h-5 w-5" />
        </Button>
      </div>
      <TerminalSettings open={settingsOpen} onOpenChange={setSettingsOpen} prefs={prefs} onApply={(p) => void applyPrefs(p)} />
      <div className="relative min-h-0 flex-1 p-1.5">
        <div ref={hostRef} className="h-full w-full" />
        {(overlay || ended) && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 p-4">
            <div className="w-full max-w-sm rounded-lg border bg-background text-foreground">
              {ended ? (
                <div className="space-y-3 p-6 text-center">
                  <p className="text-sm">{t("terminal.ended", { reason: ended })}</p>
                  <div className="flex justify-center gap-2">
                    <Button size="sm" onClick={props.onReconnect}>
                      <RefreshCw className="mr-2 h-4 w-4" />
                      {t("reconnect")}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={props.onLeave}>
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
      {touch && conn === "ready" && !ended && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-t border-white/10 px-1.5 py-1" aria-label={t("terminal.keys")}>
          {EXTRA_KEYS.map(([label, seq]) => (
            <Button
              key={label}
              size="sm"
              variant="ghost"
              className="h-8 shrink-0 px-2.5 font-mono text-white hover:bg-white/10 hover:text-white"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => sessRef.current?.write(seq)}
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
