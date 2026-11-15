import { describe, expect, it, vi } from "vitest";

import { OSC52_MAX_BYTES, osc52Handler, parseOsc52 } from "../../src/react/osc52.js";

const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64");

describe("parseOsc52", () => {
  it("takes a valid write, UTF-8 included", () => {
    expect(parseOsc52(`c;${b64("hello")}`, true)).toEqual({ kind: "write", text: "hello" });
    expect(parseOsc52(`c;${b64("привет ✓")}`, true)).toEqual({ kind: "write", text: "привет ✓" });
  });

  it("accepts an empty selection and one that names the clipboard among others", () => {
    expect(parseOsc52(`;${b64("a")}`, true)).toEqual({ kind: "write", text: "a" });
    expect(parseOsc52(`pc0;${b64("a")}`, true)).toEqual({ kind: "write", text: "a" });
  });

  it("ignores selections that are not the clipboard", () => {
    expect(parseOsc52(`p;${b64("a")}`, true)).toEqual({ kind: "ignore", reason: "selection" });
    expect(parseOsc52(`0;${b64("a")}`, true)).toEqual({ kind: "ignore", reason: "selection" });
  });

  it("does nothing while the option is off", () => {
    expect(parseOsc52(`c;${b64("hello")}`, false)).toEqual({ kind: "ignore", reason: "disabled" });
  });

  it("refuses a query always, option on or off", () => {
    expect(parseOsc52("c;?", true)).toEqual({ kind: "ignore", reason: "query" });
    expect(parseOsc52("c;?", false)).toEqual({ kind: "ignore", reason: "query" });
    expect(parseOsc52(";?", true)).toEqual({ kind: "ignore", reason: "query" });
  });

  it("ignores a payload over the cap, by encoded and by decoded size", () => {
    const atCap = new Uint8Array(OSC52_MAX_BYTES).fill(97);
    expect(parseOsc52(`c;${b64(atCap)}`, true).kind).toBe("write");
    const over = new Uint8Array(OSC52_MAX_BYTES + 1).fill(97);
    expect(parseOsc52(`c;${b64(over)}`, true)).toEqual({ kind: "ignore", reason: "too-large" });
    expect(parseOsc52(`c;${"A".repeat(Math.ceil(OSC52_MAX_BYTES / 3) * 4 + 4)}`, true)).toEqual({ kind: "ignore", reason: "too-large" });
  });

  it("ignores bad base64 and bad UTF-8", () => {
    for (const bad of ["not base64!", "aGVsbG8", "aGV sbG8=", "a===", "aGVsbG8=aGVsbG8="]) {
      expect(parseOsc52(`c;${bad}`, true), bad).toEqual({ kind: "ignore", reason: "bad-base64" });
    }
    expect(parseOsc52(`c;${b64(new Uint8Array([0xff, 0xfe, 0x41]))}`, true)).toEqual({ kind: "ignore", reason: "bad-utf8" });
  });

  it("ignores malformed sequences and an empty payload", () => {
    expect(parseOsc52("c", true)).toEqual({ kind: "ignore", reason: "malformed" });
    expect(parseOsc52(`c;${b64("a")};x`, true)).toEqual({ kind: "ignore", reason: "malformed" });
    expect(parseOsc52(`z;${b64("a")}`, true)).toEqual({ kind: "ignore", reason: "malformed" });
    expect(parseOsc52("c;", true)).toEqual({ kind: "ignore", reason: "empty" });
  });
});

describe("osc52Handler", () => {
  it("writes to the clipboard when enabled, and always consumes the sequence", () => {
    const write = vi.fn(async () => {});
    expect(osc52Handler(() => true, write)(`c;${b64("hi")}`)).toBe(true);
    expect(write).toHaveBeenCalledWith("hi");
  });

  it("writes nothing when off, on a query, or on garbage", () => {
    const write = vi.fn(async () => {});
    expect(osc52Handler(() => false, write)(`c;${b64("hi")}`)).toBe(true);
    expect(osc52Handler(() => true, write)("c;?")).toBe(true);
    expect(osc52Handler(() => true, write)("c;%%%")).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it("reads the option on every sequence", () => {
    const write = vi.fn(async () => {});
    let on = false;
    const h = osc52Handler(() => on, write);
    h(`c;${b64("a")}`);
    on = true;
    h(`c;${b64("b")}`);
    expect(write.mock.calls).toEqual([["b"]]);
  });

  it("drops a rejected write and a throwing one without an unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    osc52Handler(() => true, () => Promise.reject(new Error("denied")))(`c;${b64("a")}`);
    osc52Handler(() => true, () => {
      throw new Error("sync");
    })(`c;${b64("a")}`);
    await new Promise((r) => setTimeout(r, 20));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("is quiet without navigator.clipboard", () => {
    vi.stubGlobal("navigator", {});
    try {
      expect(osc52Handler(() => true)(`c;${b64("a")}`)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
