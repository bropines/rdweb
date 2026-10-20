// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { encodeBase64 } from "../../src/index.js";
import {
  clearStoredData,
  hasRememberedHash,
  loadPrefs,
  loadRecent,
  loadRememberedHash,
  migrateStorage,
  pushRecent,
  saveRememberedHash,
  savePrefs,
} from "../../src/react/prefs.js";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const hash = new Uint8Array([1, 2, 3, 4]);

describe("prefs storage", () => {
  beforeEach(() => localStorage.clear());

  it("reads what RD Panel stored under its prefix and removes its legacy plaintext passwords", () => {
    // exactly what the panel's web client wrote before the UI moved into rdweb
    localStorage.setItem(
      "rdpanel.webclient.prefs",
      JSON.stringify({
        settings: { imageQuality: "best", codec: "vp9", viewOnly: true },
        view: { scaleMode: "original", inputMode: "touch", zoomCursor: true, showStats: true },
        toolbar: { pinned: ["files", "chat"], keepOpen: true, position: 0.3 },
      }),
    );
    localStorage.setItem(`rdpanel.webclient.pw.${KEY.slice(0, 16)}.123456789`, JSON.stringify(encodeBase64(hash)));
    localStorage.setItem("rdpanel.webclient.recent", JSON.stringify([{ id: "123456789", name: "office", at: 1 }]));
    localStorage.setItem("rdpanel_pwd_123456789", "plaintext");
    localStorage.setItem("rdpanel_webclient_server_settings", "{}");
    localStorage.setItem("unrelated", "x");

    migrateStorage("rdpanel.webclient");
    expect(localStorage.getItem("rdpanel_pwd_123456789")).toBeNull();
    expect(localStorage.getItem("rdpanel_webclient_server_settings")).toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("x");

    const p = loadPrefs("rdpanel.webclient");
    expect(p.settings.imageQuality).toBe("best");
    expect(p.settings.codec).toBe("vp9");
    expect(p.settings.viewOnly).toBe(false); // never restored
    expect(p.settings.keyboardMode).toBe("map"); // defaults fill the gaps
    expect(p.view).toEqual({ scaleMode: "original", inputMode: "touch", zoomCursor: true, showStats: true });
    expect(p.toolbar).toEqual({ pinned: ["files", "chat"], keepOpen: true, position: 0.3 });
    expect(loadRememberedHash(KEY, "123456789", "rdpanel.webclient")).toEqual(hash);
    expect(loadRecent("rdpanel.webclient")).toEqual([{ id: "123456789", name: "office", at: 1 }]);

    // other prefixes neither see nor touch the panel's data
    migrateStorage("rdweb");
    expect(loadPrefs().view.scaleMode).toBe("fit");
    expect(loadRememberedHash(KEY, "123456789")).toBeUndefined();
    expect(loadRecent()).toEqual([]);
  });

  it("keeps the panel's key layout for every prefix", () => {
    savePrefs(loadPrefs("x"), "x");
    saveRememberedHash(KEY, "42", hash, "x");
    pushRecent("42", "pc", "x");
    pushRecent("43", undefined, "x");
    pushRecent("42", "pc2", "x");
    expect(Object.keys(localStorage).sort()).toEqual(["x.prefs", `x.pw.${KEY.slice(0, 16)}.42`, "x.recent"]);
    expect(hasRememberedHash(KEY, "42", "x")).toBe(true);
    expect(loadRecent("x").map((r) => [r.id, r.name])).toEqual([
      ["42", "pc2"],
      ["43", undefined],
    ]);
    saveRememberedHash(KEY, "42", null, "x");
    expect(hasRememberedHash(KEY, "42", "x")).toBe(false);
  });

  it("clears one prefix only", () => {
    saveRememberedHash(KEY, "1", hash, "a");
    pushRecent("1", undefined, "a");
    saveRememberedHash(KEY, "1", hash, "b");
    clearStoredData("a");
    expect(hasRememberedHash(KEY, "1", "a")).toBe(false);
    expect(loadRecent("a")).toEqual([]);
    expect(hasRememberedHash(KEY, "1", "b")).toBe(true);
  });
});
