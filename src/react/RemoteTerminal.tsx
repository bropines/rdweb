import { ChevronLeft, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { TerminalSession } from "../terminal.js";
import { ConnectPane, type ConnState } from "./FilesSheet.js";
import { useI18n } from "./i18n/index.js";
import { cn, SCOPE } from "./lib/utils.js";
import { DEFAULT_STORAGE_KEY, loadRememberedHash } from "./prefs.js";
import type { RemoteDesktopProps } from "./RemoteDesktop.js";
import { Button } from "./ui/button.js";
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
      if (disposed) return;
      injectXtermCss();
      term = new Terminal({
        cursorBlink: true,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: 14,
        scrollback: 5000,
        theme: { background: "#0a0a0a" },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      fit.fit();
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

  const overlay = conn !== "ready" && !ended;
  return (
    <div className={cn(SCOPE, "fixed inset-0 flex flex-col bg-[#0a0a0a] text-white", props.className)}>
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-2 py-2">
        <Button size="icon" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" aria-label={t("toolbar.back")} title={t("toolbar.back")} onClick={props.onLeave}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <div className="min-w-0 truncate text-sm font-medium">
          {t("terminal.title")} · {title}
        </div>
      </div>
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
