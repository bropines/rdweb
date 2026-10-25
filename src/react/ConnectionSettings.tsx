import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";

import { DEFAULT_SETTINGS, type InputMode } from "../index.js";
import { I18nProvider, useI18n, type DeepPartial, type Lang, type Messages } from "./i18n/index.js";
import { cn, SCOPE } from "./lib/utils.js";
import { DEFAULT_STORAGE_KEY, DEFAULT_VIEW, loadPrefs, savePrefs, type WebClientPrefs } from "./prefs.js";
import { SettingsFields } from "./SettingsSheet.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.js";

export interface ConnectionSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** localStorage prefix, as for RemoteDesktop (default "rdweb"). */
  storageKey?: string;
  lang?: Lang;
  messages?: DeepPartial<Messages>;
}

/**
 * The default connection settings (codec, quality, scaling, input, …) for
 * devices that have none of their own, edited before connecting. What a
 * session changes is remembered for that device instead.
 */
export function ConnectionSettingsDialog(props: ConnectionSettingsDialogProps) {
  return (
    <I18nProvider lang={props.lang} messages={props.messages}>
      <ConnectionSettingsInner {...props} />
    </I18nProvider>
  );
}

const touchFirst = () => typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches && !window.matchMedia?.("(pointer: fine)").matches;

function ConnectionSettingsInner({ open, onOpenChange, storageKey = DEFAULT_STORAGE_KEY }: ConnectionSettingsDialogProps) {
  const { t } = useI18n();
  const [prefs, setPrefs] = useState<WebClientPrefs>(() => loadPrefs(storageKey));
  useEffect(() => {
    if (open) setPrefs(loadPrefs(storageKey));
  }, [open, storageKey]);
  const update = (next: WebClientPrefs) => {
    setPrefs(next);
    savePrefs(next, storageKey);
  };
  const inputMode: InputMode = prefs.view.inputMode ?? (touchFirst() ? "trackpad" : "mouse");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(SCOPE, "max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] overflow-y-auto overflow-x-hidden sm:max-w-3xl")} closeLabel={t("common.close")}>
        <DialogHeader>
          <DialogTitle>{t("defaults.title")}</DialogTitle>
          <DialogDescription>{t("defaults.desc")}</DialogDescription>
        </DialogHeader>
        <SettingsFields
          settings={prefs.settings}
          onSettings={(patch) => update({ ...prefs, settings: { ...prefs.settings, ...patch } })}
          view={prefs.view}
          inputMode={inputMode}
          onView={(patch) => update({ ...prefs, view: { ...prefs.view, ...patch } })}
          peer={null}
          layout="columns"
        />
        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => update({ ...prefs, settings: { ...DEFAULT_SETTINGS }, view: { ...DEFAULT_VIEW, showStats: prefs.view.showStats } })}
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            {t("defaults.reset")}
          </Button>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
