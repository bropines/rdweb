import { Import, Info } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@ui/dialog";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { Textarea } from "@ui/misc";

import { useAppI18n } from "./i18n";
import { decodeConfigString, endpoints, entryFromConfig, hostOf, keyProblem, newServerId, type ServerEntry } from "./servers";

interface Props {
  /** null: closed; {}: new server; an entry: edit it. */
  editing: Partial<ServerEntry> | null;
  onClose: () => void;
  onSave: (s: ServerEntry) => void;
}

export function ServerEditor({ editing, onClose, onSave }: Props) {
  const { t } = useAppI18n();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [relay, setRelay] = useState("");
  const [key, setKey] = useState("");
  const [config, setConfig] = useState("");
  const [configError, setConfigError] = useState(false);
  const [apiHost, setApiHost] = useState("");
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!editing) return;
    setName(editing.name ?? "");
    setAddress(editing.address ?? "");
    setRelay(editing.relay ?? "");
    setKey(editing.key ?? "");
    setConfig("");
    setConfigError(false);
    setApiHost("");
    setTouched(false);
  }, [editing]);

  const importConfig = () => {
    try {
      const cfg = decodeConfigString(config);
      const e = entryFromConfig(cfg);
      setName((n) => n || e.name);
      setAddress(e.address);
      setRelay(e.relay ?? "");
      if (e.key) setKey(e.key);
      const api = hostOf(cfg.api);
      setApiHost(/^https:\/\//i.test(cfg.api) && api && api !== e.address ? api : "");
      setConfig("");
      setConfigError(false);
      toast.success(t("editor.imported"));
    } catch {
      setConfigError(true);
    }
  };

  const keyErr = key.trim() ? keyProblem(key) : null;
  const addressOk = !!address.trim() && (/^wss?:\/\//i.test(address.trim()) || !!hostOf(address));
  const resolved = addressOk ? endpoints(address, relay) : null;
  const valid = addressOk && !!key.trim() && !keyErr;

  const save = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!valid) return;
    const host = hostOf(address);
    onSave({
      id: editing?.id ?? newServerId(),
      name: name.trim() || host,
      address: address.trim(),
      relay: relay.trim() || undefined,
      key: key.trim(),
    });
  };

  return (
    <Dialog open={!!editing} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] max-w-[calc(100vw-1rem)] overflow-y-auto sm:max-w-lg" closeLabel={t("about.close")}>
        <form onSubmit={save} className="space-y-4" noValidate>
          <DialogHeader>
            <DialogTitle>{editing?.id ? t("servers.edit") : t("servers.add")}</DialogTitle>
            <DialogDescription>{t("editor.addressHint")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-2 rounded-md border bg-muted/40 p-3">
            <Label htmlFor="srv-config" className="flex items-center gap-1.5">
              <Import className="h-4 w-4" />
              {t("editor.importTitle")}
            </Label>
            <p className="text-xs text-muted-foreground">{t("editor.importHint")}</p>
            <div className="flex gap-2">
              <Input
                id="srv-config"
                value={config}
                onChange={(e) => {
                  setConfig(e.target.value);
                  setConfigError(false);
                }}
                className="font-mono text-xs"
                autoComplete="off"
                spellCheck={false}
                placeholder="=0nI…"
              />
              <Button type="button" variant="secondary" onClick={importConfig} disabled={!config.trim()}>
                {t("editor.importButton")}
              </Button>
            </div>
            {configError && <p className="text-xs text-destructive">{t("editor.importFailed")}</p>}
          </div>

          {apiHost && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/40 p-3 text-xs">
              <span className="min-w-0 flex-1">{t("editor.apiHost", { host: apiHost })}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setAddress(apiHost);
                  setApiHost("");
                }}
              >
                {t("editor.useApiHost", { host: apiHost })}
              </Button>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="srv-name">{t("editor.name")}</Label>
            <Input id="srv-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("editor.namePlaceholder")} autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="srv-address">{t("editor.address")}</Label>
            <Input
              id="srv-address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder={t("editor.addressPlaceholder")}
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
              aria-invalid={touched && !addressOk}
            />
            {touched && !addressOk && <p className="text-xs text-destructive">{t("editor.addressRequired")}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="srv-relay">{t("editor.relay")}</Label>
            <Input
              id="srv-relay"
              value={relay}
              onChange={(e) => setRelay(e.target.value)}
              placeholder={t("editor.relayPlaceholder")}
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
            />
            <p className="text-xs text-muted-foreground">{t("editor.relayHint")}</p>
          </div>
          {resolved && (
            <p className="break-all rounded-md bg-muted px-3 py-2 font-mono text-[11px] text-muted-foreground">
              {resolved.relayUrl ? t("editor.resolved", { id: resolved.rendezvousUrl, relay: resolved.relayUrl }) : t("editor.resolvedNoRelay", { id: resolved.rendezvousUrl })}
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="srv-key">{t("editor.key")}</Label>
            <Textarea
              id="srv-key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              rows={2}
              className="font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
              placeholder="id_ed25519.pub"
              aria-invalid={touched && (!key.trim() || !!keyErr)}
            />
            {touched && !key.trim() && <p className="text-xs text-destructive">{t("editor.keyRequired")}</p>}
            {keyErr && <p className="text-xs text-destructive">{t("editor.keyInvalid", { detail: keyErr })}</p>}
            <p className="text-xs text-muted-foreground">{t("editor.keyHint")}</p>
          </div>

          <div className="flex gap-2 rounded-md border p-3 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <div className="font-medium text-foreground">{t("editor.requirementsTitle")}</div>
              {t("editor.requirements")}
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              {t("editor.cancel")}
            </Button>
            <Button type="submit" disabled={touched && !valid}>
              {t("editor.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
