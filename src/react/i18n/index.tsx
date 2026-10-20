import { createContext, useContext, useMemo, type ReactNode } from "react";

import { en, type Messages } from "./en.js";
import { ru } from "./ru.js";

export type { Messages };

export type Lang = "en" | "ru";

/** Any subset of a message catalog, for overriding single strings. */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends string ? string : DeepPartial<T[K]> };

/** Built-in catalogs. Russian must have every key English has (checked by the compiler and a test). */
export const messages: Record<Lang, Messages> = { en, ru };

export interface TranslateOptions {
  /** Selects the plural form (`key_one`, `key_few`, ...) and fills `{{count}}`. */
  count?: number;
  /** Returned when the key is missing everywhere. */
  defaultValue?: string;
  [name: string]: string | number | undefined;
}

/** `t("files.selected", { count: 3 })`, `t("errors.network", { detail })`. */
export type Translate = (key: string, vars?: TranslateOptions) => string;

/** "ru-RU" → "ru"; anything unknown → "en". */
export function resolveLang(lang: string | undefined | null): Lang {
  const base = (lang ?? "").toLowerCase().split(/[-_]/)[0];
  return base === "ru" ? "ru" : "en";
}

type Tree = { [key: string]: string | Tree };

function lookup(tree: Tree | undefined, path: string): string | undefined {
  let node: string | Tree | undefined = tree;
  for (const part of path.split(".")) {
    if (!node || typeof node === "string") return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

function merge(base: Tree, over: Tree | undefined): Tree {
  if (!over) return base;
  const out: Tree = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    const b = out[k];
    out[k] = typeof v === "string" || typeof b !== "object" ? v : merge(b, v);
  }
  return out;
}

function interpolate(s: string, vars: TranslateOptions | undefined): string {
  if (!vars) return s;
  return s.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name: string) => {
    const v = vars[name];
    return v === undefined ? m : String(v);
  });
}

/**
 * Builds a translator for `lang` with optional overrides of single strings.
 * Missing keys fall back to English, then to `defaultValue`, then to the key.
 */
export function createTranslator(lang: string = "en", overrides?: DeepPartial<Messages>): Translate {
  const code = resolveLang(lang);
  const dict = merge(messages[code] as unknown as Tree, overrides as Tree | undefined);
  const fallback = messages.en as unknown as Tree;
  const plural = new Intl.PluralRules(code);
  return (key, vars) => {
    const candidates =
      typeof vars?.count === "number" ? [`${key}_${plural.select(vars.count)}`, `${key}_other`, key] : [key];
    for (const tree of [dict, fallback]) {
      for (const k of candidates) {
        const s = lookup(tree, k);
        if (s !== undefined) return interpolate(s, vars);
      }
    }
    return vars?.defaultValue ?? key;
  };
}

export interface I18nValue {
  t: Translate;
  lang: Lang;
}

const I18nContext = createContext<I18nValue>({ t: createTranslator("en"), lang: "en" });

/**
 * Provides strings to rdweb components rendered outside `RemoteDesktop`
 * (which sets up its own provider from its `lang`/`messages` props).
 */
export function I18nProvider({ lang, messages: overrides, children }: { lang?: string; messages?: DeepPartial<Messages>; children: ReactNode }) {
  const code = resolveLang(lang);
  const value = useMemo<I18nValue>(() => ({ t: createTranslator(code, overrides), lang: code }), [code, overrides]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
