import { describe, expect, it } from "vitest";
import type { ServerCheck, ServerCheckStep } from "../../src/check.js";

import { CHECK_HINTS, checkHint } from "../../app/src/checkHint.js";
import { appTranslator } from "../../app/src/i18n.js";
import { INSTALL_PLATFORMS } from "../../app/src/platform.js";

const LANGS = ["en", "ru"] as const;

describe("app strings built from keys", () => {
  it("exist in both languages for every platform, hint, step and status", () => {
    const keys = [
      ...[...INSTALL_PLATFORMS, "other"].flatMap((p) => [`install.platform.${p}`, `install.steps.${p}`]),
      ...["vpn", "clearData", "xiaomi", "otherBrowser", "shortcut"].map((k) => `install.trouble.${k}`),
      ...CHECK_HINTS.map((h) => `check.hint.${h}`),
      ...["rendezvous", "key", "relay", "device"].map((s) => `check.step.${s}`),
      ...["ok", "fail", "skip", "running"].map((s) => `check.status.${s}`),
      ...["github", "play", "fdroid", "appstore"].map((s) => `official.${s}`),
    ];
    for (const lang of LANGS) {
      const t = appTranslator(lang);
      for (const k of keys) expect(t(k), `${lang}: ${k}`).not.toBe(k);
    }
  });
});

describe("checkHint", () => {
  const result = (...steps: ServerCheckStep[]): ServerCheck => ({ ok: false, steps, rendezvousUrl: "", relayUrl: "" });

  it("explains failures and skips", () => {
    const down = result({ id: "rendezvous", status: "fail", code: "unreachable" }, { id: "key", status: "skip" }, { id: "device", status: "skip" });
    expect(down.steps.map((s) => checkHint(s, down))).toEqual(["rendezvous", "notReached", "notReached"]);

    const up = result(
      { id: "rendezvous", status: "ok" },
      { id: "key", status: "skip" },
      { id: "relay", status: "fail", code: "timeout" },
      { id: "device", status: "fail", code: "offline" },
    );
    expect(up.steps.map((s) => checkHint(s, up))).toEqual([null, "keySkipped", "relay", "offline"]);

    expect(checkHint({ id: "key", status: "fail", code: "key-mismatch" }, up)).toBe("keyMismatch");
    expect(checkHint({ id: "key", status: "fail", code: "bad-config" }, up)).toBe("keyInvalid");
    expect(checkHint({ id: "relay", status: "fail", code: "bad-config" }, up)).toBe("badUrl");
    expect(checkHint({ id: "device", status: "ok" }, up)).toBe("online");
  });
});
