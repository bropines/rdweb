import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "../src/index.js";
import { decodingOffer } from "../src/session.js";

const all = { decode: new Set(["vp8", "vp9", "av1", "h264", "h265"] as const), decode444: new Set(["vp9"] as const) };

describe("decoding offer", () => {
  it("leaves H.265 out unless it is chosen", () => {
    expect(decodingOffer(all, { ...DEFAULT_SETTINGS, codec: "auto" }).abilityH265).toBe(0);
    expect(decodingOffer(all, { ...DEFAULT_SETTINGS, codec: "vp9" }).abilityH265).toBe(0);
    expect(decodingOffer(all, { ...DEFAULT_SETTINGS, codec: "h265" }).abilityH265).toBe(1);
    const auto = decodingOffer(all, { ...DEFAULT_SETTINGS, codec: "auto" });
    expect([auto.abilityVp8, auto.abilityVp9, auto.abilityAv1, auto.abilityH264]).toEqual([1, 1, 1, 1]);
  });

  it("never offers what the browser cannot decode", () => {
    const none = { decode: new Set<never>(), decode444: new Set<never>() };
    expect(decodingOffer(none, { ...DEFAULT_SETTINGS, codec: "h265" }).abilityH265).toBe(0);
  });
});
