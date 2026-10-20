// "Install": the browser's own prompt when it offers one, and in any case the
// steps for this browser, the other platforms and Android troubleshooting
// (Chrome's WebAPK install can fail even with a valid manifest).
import { Download } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@ui/dialog";

import { useAppI18n } from "./i18n";
import { OfficialApps } from "./OfficialApps";
import { detectInstallPlatform, INSTALL_PLATFORMS, isAndroid, type InstallPlatform } from "./platform";
import { promptInstall, useInstallState } from "./pwa";

const TROUBLE = ["vpn", "clearData", "xiaomi", "otherBrowser", "shortcut"] as const;

export function InstallDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useAppI18n();
  const state = useInstallState();
  const platform = useMemo<InstallPlatform>(() => detectInstallPlatform(navigator.userAgent, navigator.maxTouchPoints), []);
  const others = INSTALL_PLATFORMS.filter((p) => p !== platform);

  const trouble = (
    <div className="space-y-1.5">
      <h4 className="font-medium">{t("install.troubleTitle")}</h4>
      <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
        {TROUBLE.map((k) => (
          <li key={k}>{t(`install.trouble.${k}`)}</li>
        ))}
      </ul>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] max-w-[calc(100vw-1rem)] overflow-y-auto sm:max-w-lg" closeLabel={t("about.close")}>
        <DialogHeader>
          <DialogTitle>{t("install.title")}</DialogTitle>
          <DialogDescription>{t("install.hint")}</DialogDescription>
        </DialogHeader>

        {state === "prompt" && (
          <Button
            onClick={() =>
              void promptInstall()
                .then((accepted) => accepted && onOpenChange(false))
                .catch(() => {})
            }
          >
            <Download className="h-4 w-4" />
            {t("install.button")}
          </Button>
        )}

        <div className="space-y-3 text-sm">
          <section className="space-y-1.5 rounded-md border bg-muted/40 p-3">
            <h3 className="font-medium">
              {t("install.here")}: {t(`install.platform.${platform}`)}
            </h3>
            <p className="text-muted-foreground">{t(`install.steps.${platform}`)}</p>
          </section>

          {isAndroid(platform) && trouble}

          <details className="group rounded-md border px-3 py-2">
            <summary className="cursor-pointer select-none font-medium">{t("install.others")}</summary>
            <dl className="mt-2 space-y-2">
              {others.map((p) => (
                <div key={p}>
                  <dt className="font-medium">{t(`install.platform.${p}`)}</dt>
                  <dd className="text-muted-foreground">{t(`install.steps.${p}`)}</dd>
                </div>
              ))}
            </dl>
            {!isAndroid(platform) && <div className="mt-3">{trouble}</div>}
          </details>

          <OfficialApps className="pt-1" />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("about.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
