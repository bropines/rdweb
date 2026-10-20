import { describe, expect, it } from "vitest";

import { createTranslator, messages, resolveLang } from "../../src/react/i18n/index.js";

type Tree = { [k: string]: string | Tree };

const PLURAL = /_(zero|one|two|few|many|other)$/;

function flat(tree: Tree, prefix = ""): Record<string, string> {
  return Object.entries(tree).reduce<Record<string, string>>((acc, [k, v]) => {
    if (typeof v === "string") acc[prefix + k] = v;
    else Object.assign(acc, flat(v, `${prefix}${k}.`));
    return acc;
  }, {});
}

/** Keys with plural suffixes collapsed (en has one/other, ru has one/few/many/other). */
const baseKeys = (tree: Tree) => [...new Set(Object.keys(flat(tree)).map((k) => k.replace(PLURAL, "")))].sort();
const vars = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();

const en = messages.en as unknown as Tree;
const ru = messages.ru as unknown as Tree;

describe("messages", () => {
  it("ru has exactly the same keys as en (modulo plural forms)", () => {
    expect(baseKeys(ru)).toEqual(baseKeys(en));
  });

  it("plural keys have every form the language needs", () => {
    const enKeys = Object.keys(flat(en));
    const ruKeys = new Set(Object.keys(flat(ru)));
    const plurals = [...new Set(enKeys.filter((k) => PLURAL.test(k)).map((k) => k.replace(PLURAL, "")))];
    expect(plurals.length).toBeGreaterThan(0);
    for (const base of plurals) {
      expect(enKeys).toContain(`${base}_one`);
      expect(enKeys).toContain(`${base}_other`);
      for (const form of ["one", "few", "many", "other"]) expect(ruKeys.has(`${base}_${form}`), `${base}_${form}`).toBe(true);
    }
  });

  it("has no empty strings and keeps interpolation variables", () => {
    const e = flat(en);
    const r = flat(ru);
    for (const [k, v] of [...Object.entries(e), ...Object.entries(r)]) expect(v.trim(), k).not.toBe("");
    for (const [k, v] of Object.entries(r)) {
      const enValue = e[k] ?? e[k.replace(PLURAL, "_other")];
      expect(enValue, k).toBeDefined();
      expect(vars(v), k).toEqual(vars(enValue!));
    }
  });
});

describe("createTranslator", () => {
  it("picks plural forms with Intl.PluralRules", () => {
    const t = createTranslator("ru");
    expect(t("files.nFiles", { count: 1 })).toBe("1 файл");
    expect(t("files.nFiles", { count: 3 })).toBe("3 файла");
    expect(t("files.nFiles", { count: 5 })).toBe("5 файлов");
    expect(createTranslator("en")("files.nFiles", { count: 1 })).toBe("1 file");
    expect(createTranslator("en")("files.nFiles", { count: 2 })).toBe("2 files");
  });

  it("interpolates, overrides, falls back", () => {
    const t = createTranslator("en-GB", { toolbar: { back: "Back to the panel" }, errors: { network: "Net: {{detail}}" } });
    expect(t("toolbar.back")).toBe("Back to the panel");
    expect(t("toolbar.more")).toBe("More");
    expect(t("errors.network", { detail: "boom" })).toBe("Net: boom");
    expect(t("toolbar.nextDisplay", { n: 1, total: 2 })).toBe("Next monitor (1 of 2)");
    expect(t("state.unknown", { defaultValue: "unknown" })).toBe("unknown");
    expect(t("no.such.key")).toBe("no.such.key");
    expect(createTranslator("ru")("common.cancel")).toBe("Отмена");
  });

  it("resolves languages", () => {
    expect(resolveLang("ru-RU")).toBe("ru");
    expect(resolveLang("de")).toBe("en");
    expect(resolveLang(undefined)).toBe("en");
  });
});
