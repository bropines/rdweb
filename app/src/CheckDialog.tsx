// "Check" on a server: runs checkServer (ID server, key, relay and optionally
// a device's presence; no device is contacted) and explains each failure.
import { CircleCheck, CircleMinus, CircleX, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { checkServer, type ServerCheck, type ServerCheckStep, type ServerCheckStepId, type ServerConfig } from "rdweb";
import { Button } from "@ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@ui/dialog";
import { Input } from "@ui/input";
import { Label } from "@ui/label";

import { checkHint } from "./checkHint";
import { useAppI18n, type AppT } from "./i18n";

export interface CheckTarget {
  name: string;
  server: ServerConfig;
}

function StatusIcon({ status, t }: { status: ServerCheckStep["status"] | "running"; t: AppT }) {
  const label = t(`check.status.${status}`);
  const cls = "mt-0.5 h-4 w-4 shrink-0";
  if (status === "running") return <LoaderCircle className={`${cls} animate-spin text-muted-foreground`} aria-label={label} role="img" />;
  if (status === "ok") return <CircleCheck className={`${cls} text-emerald-600 dark:text-emerald-400`} aria-label={label} role="img" />;
  if (status === "fail") return <CircleX className={`${cls} text-destructive`} aria-label={label} role="img" />;
  return <CircleMinus className={`${cls} text-muted-foreground`} aria-label={label} role="img" />;
}

function StepRow({ status, label, ms, children }: { status: ServerCheckStep["status"] | "running"; label: string; ms?: number; children?: ReactNode }) {
  const { t } = useAppI18n();
  return (
    <li className="flex gap-2.5 px-3 py-2.5">
      <StatusIcon status={status} t={t} />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 break-words font-medium">{label}</span>
          {ms !== undefined && <span className="shrink-0 font-mono text-xs text-muted-foreground">{t("check.ms", { ms })}</span>}
        </div>
        {children}
      </div>
    </li>
  );
}

export function CheckDialog({ target, onClose }: { target: CheckTarget | null; onClose: () => void }) {
  const { t } = useAppI18n();
  const [peerId, setPeerId] = useState("");
  const [checkedPeer, setCheckedPeer] = useState("");
  const [result, setResult] = useState<ServerCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const ctrl = useRef<AbortController | null>(null);
  const peerRef = useRef(peerId);
  peerRef.current = peerId.replace(/\s+/g, "");

  const run = useCallback((server: ServerConfig, peer: string) => {
    ctrl.current?.abort();
    const ac = new AbortController();
    ctrl.current = ac;
    setRunning(true);
    setResult(null);
    setError(null);
    setCheckedPeer(peer);
    checkServer(server, { peerId: peer || undefined, signal: ac.signal }).then(
      (r) => {
        if (ac.signal.aborted) return;
        setResult(r);
        setRunning(false);
      },
      (e: unknown) => {
        if (ac.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
        setRunning(false);
      },
    );
  }, []);

  // Runs when the dialog opens (with a device id kept from an earlier check); "Check" runs again.
  useEffect(() => {
    if (!target) return;
    run(target.server, peerRef.current);
    return () => ctrl.current?.abort();
  }, [target, run]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (target) run(target.server, peerRef.current);
  };

  const pending: ServerCheckStepId[] = ["rendezvous", "key", "relay", ...(checkedPeer ? (["device"] as const) : [])];
  const urlOf = (id: ServerCheckStepId) => (id === "relay" ? result?.relayUrl : result?.rendezvousUrl) ?? "";

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] max-w-[calc(100vw-1rem)] overflow-y-auto sm:max-w-lg" closeLabel={t("about.close")}>
        <DialogHeader>
          <DialogTitle className="break-words pr-6">{t("check.title", { name: target?.name ?? "" })}</DialogTitle>
          <DialogDescription>{t("check.description")}</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-1.5">
          <Label htmlFor="check-peer">{t("check.device")}</Label>
          <div className="flex gap-2">
            <Input
              id="check-peer"
              value={peerId}
              onChange={(e) => setPeerId(e.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="123 456 789"
            />
            <Button type="submit" disabled={running}>
              {t("check.run")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("check.deviceHint")}</p>
        </form>

        <div aria-live="polite" className="space-y-3 text-sm">
          {result && (
            <p className={result.ok ? "font-medium text-emerald-700 dark:text-emerald-400" : "font-medium text-destructive"}>
              {t(result.ok ? "check.passed" : "check.failed")}
            </p>
          )}
          {error && <p className="text-destructive">{t("check.error", { error })}</p>}
          <ul className="divide-y rounded-md border">
            {result
              ? result.steps.map((step) => {
                  const hint = checkHint(step, result);
                  return (
                    <StepRow key={step.id} status={step.status} label={t(`check.step.${step.id}`, { id: checkedPeer })} ms={step.ms}>
                      {hint && <p className={step.status === "fail" ? "text-foreground" : "text-muted-foreground"}>{t(`check.hint.${hint}`, { url: urlOf(step.id) })}</p>}
                      {step.status === "fail" && step.detail && <p className="break-words font-mono text-[11px] text-muted-foreground">{step.detail}</p>}
                    </StepRow>
                  );
                })
              : pending.map((id) => <StepRow key={id} status={running ? "running" : "skip"} label={t(`check.step.${id}`, { id: checkedPeer })} />)}
          </ul>
          {running && <p className="text-xs text-muted-foreground">{t("check.running")}</p>}
          {result && (
            <p className="break-all font-mono text-[11px] text-muted-foreground">
              {result.rendezvousUrl} · {result.relayUrl}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("about.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
