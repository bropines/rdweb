import type { ReactNode } from "react";
import type { CodecPreference, ImageQualityPreset, InputMode, KeyboardModeName, PeerSummary, ScaleMode, SessionSettings } from "../index.js";

import { useI18n } from "./i18n/index.js";
import { Label } from "./ui/label.js";
import { Separator, Switch } from "./ui/misc.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.js";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./ui/sheet.js";
import type { ViewPrefs } from "./prefs.js";

export interface SettingsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: SessionSettings;
  onSettings: (patch: Partial<SessionSettings>) => void;
  view: ViewPrefs;
  inputMode: InputMode;
  onView: (patch: Partial<ViewPrefs>) => void;
  peer: PeerSummary | null;
  currentDisplay: number;
  onSwitchDisplay: (index: number) => void;
  resolution: string;
  onResolution: (value: string) => void;
  privacyOn: boolean;
  onPrivacy: (on: boolean) => void;
  blockInputOn: boolean;
  onBlockInput: (on: boolean) => void;
  canPrivacy: boolean;
  canBlockInput: boolean;
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className="truncate text-sm">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <Row label={label} hint={hint}>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} />
    </Row>
  );
}

function Pick<T extends string>({ label, value, options, onChange, disabled }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="grid gap-1.5 py-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={(v) => onChange(v as T)} disabled={disabled}>
        <SelectTrigger className="h-9 w-full" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function Slider({ label, value, min, max, step, unit, onChange }: { label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void }) {
  return (
    <div className="grid gap-1 py-1.5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">
          {value}
          {unit}
        </span>
      </div>
      <input
        type="range"
        className="w-full accent-primary"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

export function SettingsSheet(p: SettingsSheetProps) {
  const { t } = useI18n();
  const s = p.settings;
  const codecs = p.peer?.codecs ?? [];
  const can444 = (p.peer?.codecs444.length ?? 0) > 0;
  const resolutions = p.peer?.resolutions ?? [];
  const displays = p.peer?.displays ?? [];
  const touch = p.inputMode !== "mouse";

  return (
    <Sheet open={p.open} onOpenChange={p.onOpenChange}>
      <SheetContent className="sm:max-w-sm" closeLabel={t("common.close")}>
        <SheetHeader>
          <SheetTitle>{t("settings.title")}</SheetTitle>
          <SheetDescription className="sr-only">{t("settings.desc")}</SheetDescription>
        </SheetHeader>
        <SheetBody className="space-y-1">
          <h3 className="pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("settings.display")}</h3>
          {displays.length > 1 && (
            <Pick
              label={t("settings.monitor")}
              value={String(p.currentDisplay)}
              options={displays.map((d) => ({ value: String(d.index), label: `${d.index + 1}${d.name ? ` · ${d.name.replace(/^\\\\\.\\/, "")}` : ""} (${d.width}×${d.height})` }))}
              onChange={(v) => p.onSwitchDisplay(Number(v))}
            />
          )}
          <Pick<ScaleMode>
            label={t("settings.viewStyle")}
            value={p.view.scaleMode}
            options={[
              { value: "fit", label: t("view.fit") },
              { value: "original", label: t("view.original") },
              { value: "stretch", label: t("view.stretch") },
            ]}
            onChange={(v) => p.onView({ scaleMode: v })}
          />
          <Pick<ImageQualityPreset>
            label={t("settings.quality")}
            value={s.imageQuality}
            options={[
              { value: "best", label: t("quality.best") },
              { value: "balanced", label: t("quality.balanced") },
              { value: "low", label: t("quality.low") },
              { value: "custom", label: t("quality.custom") },
            ]}
            onChange={(v) => p.onSettings({ imageQuality: v })}
          />
          {s.imageQuality === "custom" && (
            <div className="rounded-md border px-3 py-1">
              <Slider label={t("settings.customQuality")} value={s.customQuality} min={10} max={100} step={5} unit="%" onChange={(v) => p.onSettings({ customQuality: v })} />
              <Slider label={t("settings.customFps")} value={s.customFps} min={5} max={120} step={5} unit=" fps" onChange={(v) => p.onSettings({ customFps: v })} />
            </div>
          )}
          <Pick<CodecPreference>
            label={t("settings.codec")}
            value={codecs.includes(s.codec as never) || s.codec === "auto" ? s.codec : "auto"}
            options={[{ value: "auto", label: t("codec.auto") }, ...codecs.map((c) => ({ value: c as CodecPreference, label: c.toUpperCase() }))]}
            onChange={(v) => p.onSettings({ codec: v })}
          />
          {resolutions.length > 0 && (
            <Pick
              label={t("settings.resolution")}
              value={p.resolution}
              options={[
                { value: "current", label: t("settings.resolutionCurrent") },
                { value: "0x0", label: t("settings.resolutionOriginal") },
                ...resolutions.map((r) => ({ value: `${r.width}x${r.height}`, label: `${r.width}×${r.height}` })),
              ]}
              onChange={p.onResolution}
            />
          )}
          <Toggle label={t("settings.trueColor")} hint={can444 ? undefined : t("settings.trueColorUnavailable")} checked={s.trueColor} disabled={!can444 && !s.trueColor} onChange={(v) => p.onSettings({ trueColor: v })} />
          <Toggle label={t("settings.showRemoteCursor")} checked={s.showRemoteCursor} onChange={(v) => p.onSettings({ showRemoteCursor: v })} />
          <Toggle label={t("settings.zoomCursor")} checked={p.view.zoomCursor} onChange={(v) => p.onView({ zoomCursor: v })} />
          <Toggle label={t("settings.followRemoteCursor")} checked={s.followRemoteCursor} onChange={(v) => p.onSettings({ followRemoteCursor: v })} />
          <Toggle label={t("settings.followRemoteWindow")} checked={s.followRemoteWindow} onChange={(v) => p.onSettings({ followRemoteWindow: v })} />
          <Toggle label={t("settings.showStats")} checked={p.view.showStats} onChange={(v) => p.onView({ showStats: v })} />

          <Separator className="my-2" />
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("settings.control")}</h3>
          <Pick<InputMode>
            label={t("settings.inputMode")}
            value={p.inputMode}
            options={[
              { value: "mouse", label: t("input.mouse") },
              { value: "trackpad", label: t("input.trackpad") },
              { value: "touch", label: t("input.touch") },
            ]}
            onChange={(v) => p.onView({ inputMode: v })}
          />
          {touch && <p className="pb-1 text-xs text-muted-foreground">{t(`input.${p.inputMode}Hint`)}</p>}
          <Pick<KeyboardModeName>
            label={t("settings.keyboardMode")}
            value={s.keyboardMode}
            options={[
              { value: "map", label: t("keyboard.map") },
              { value: "translate", label: t("keyboard.translate") },
              { value: "legacy", label: t("keyboard.legacy") },
            ]}
            onChange={(v) => p.onSettings({ keyboardMode: v })}
          />
          <Toggle label={t("settings.swapCtrlMeta")} checked={s.swapCtrlMeta} onChange={(v) => p.onSettings({ swapCtrlMeta: v })} />
          <Toggle label={t("settings.viewOnly")} checked={s.viewOnly} onChange={(v) => p.onSettings({ viewOnly: v })} />
          <Toggle label={t("settings.mute")} checked={s.disableAudio} onChange={(v) => p.onSettings({ disableAudio: v })} />
          <Toggle label={t("settings.disableClipboard")} checked={s.disableClipboard} onChange={(v) => p.onSettings({ disableClipboard: v })} />
          <Toggle label={t("settings.lockAfterSession")} checked={s.lockAfterSessionEnd} onChange={(v) => p.onSettings({ lockAfterSessionEnd: v })} />
          {p.canPrivacy && <Toggle label={t("settings.privacyMode")} checked={p.privacyOn} onChange={p.onPrivacy} />}
          {p.canBlockInput && <Toggle label={t("settings.blockInput")} checked={p.blockInputOn} onChange={p.onBlockInput} />}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
