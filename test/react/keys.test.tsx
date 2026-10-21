// @vitest-environment jsdom
import "./setup-dom.js";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExtraKeys } from "../../src/react/ExtraKeys.js";
import { desktopLayout, modifyText, physicalKey, TERMINAL_LAYOUT, terminalKey } from "../../src/react/keys.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const none = { ctrl: false, alt: false, shift: false };

describe("terminal keys", () => {
  it("sends xterm sequences, with the modifier parameter when latched", () => {
    expect(terminalKey("up", none)).toBe("\x1b[A");
    expect(terminalKey("up", none, true)).toBe("\x1bOA");
    expect(terminalKey("left", { ...none, ctrl: true })).toBe("\x1b[1;5D");
    expect(terminalKey("right", { ...none, alt: true, shift: true })).toBe("\x1b[1;4C");
    expect(terminalKey("home", none)).toBe("\x1b[H");
    expect(terminalKey("pgup", none)).toBe("\x1b[5~");
    expect(terminalKey("del", { ...none, ctrl: true })).toBe("\x1b[3;5~");
    expect(terminalKey("f1", none)).toBe("\x1bOP");
    expect(terminalKey("f5", none)).toBe("\x1b[15~");
    expect(terminalKey("f12", { ...none, shift: true })).toBe("\x1b[24;2~");
    expect(terminalKey("tab", { ...none, shift: true })).toBe("\x1b[Z");
    expect(terminalKey("esc", { ...none, alt: true })).toBe("\x1b\x1b");
    expect(terminalKey("^c", none)).toBe("\x03");
    expect(terminalKey("|", none)).toBe("|");
    expect(terminalKey("paste", none)).toBeNull();
  });

  it("applies latched modifiers to typed text", () => {
    expect(modifyText("c", { ...none, ctrl: true })).toBe("\x03");
    expect(modifyText("с", { ...none, ctrl: true })).toBe("\x03"); // Cyrillic es
    expect(modifyText("m", { ...none, alt: true })).toBe("\x1bm");
    expect(modifyText("\r", { ...none, shift: true })).toBe("\x1b\r");
    expect(modifyText("a", { ...none, shift: true })).toBe("A");
    expect(modifyText("ls", { ...none, ctrl: true })).toBe("ls");
    expect(modifyText("x", none)).toBe("x");
  });

  it("puts the pinned more key in the base rows", () => {
    expect(TERMINAL_LAYOUT.base.flat().map((k) => k.id)).toContain("more");
    expect(TERMINAL_LAYOUT.more.flat().some((k) => k.id === "more")).toBe(false);
  });
});

describe("desktop keys", () => {
  it("finds the physical key for typed characters", () => {
    expect(physicalKey("c")).toEqual({ code: "KeyC", key: "c" });
    expect(physicalKey("С")).toEqual({ code: "KeyC", key: "c" });
    expect(physicalKey("7")).toEqual({ code: "Digit7", key: "7" });
    expect(physicalKey("/")).toEqual({ code: "Slash", key: "/" });
    expect(physicalKey("€")).toBeNull();
    expect(physicalKey("ab")).toBeNull();
  });

  it("names the Windows key after the remote system", () => {
    const label = (os?: string) => desktopLayout(os).base.flat().find((k) => k.id === "meta")?.label;
    expect(label("windows")).toBe("Win");
    expect(label("macos")).toBe("Cmd");
    expect(label("linux")).toBe("Super");
  });
});

describe("ExtraKeys", () => {
  const renderKeys = (onKey = vi.fn(), latched: Set<string> = new Set()) => {
    render(
      <ExtraKeys
        base={TERMINAL_LAYOUT.base}
        more={TERMINAL_LAYOUT.more}
        latched={latched}
        onKey={onKey}
        label="Extra keys"
        moreLabel="More keys"
        lessLabel="Fewer keys"
      />,
    );
    return onKey;
  };
  const key = (name: string) => screen.getByRole("button", { name });
  const tap = (el: HTMLElement, y0 = 100, y1 = y0) => {
    fireEvent.pointerDown(el, { pointerId: 1, clientY: y0 });
    fireEvent.pointerUp(el, { pointerId: 1, clientY: y1 });
  };

  it("fires on release, and the swipe-up character on a swipe up", () => {
    const onKey = renderKeys();
    fireEvent.pointerDown(key("Esc"), { pointerId: 1, clientY: 100 });
    expect(onKey).not.toHaveBeenCalled();
    fireEvent.pointerUp(key("Esc"), { pointerId: 1, clientY: 100 });
    expect(onKey).toHaveBeenLastCalledWith("esc");
    tap(key("-"), 100, 70);
    expect(onKey).toHaveBeenLastCalledWith("|");
    tap(key("-"), 100, 95);
    expect(onKey).toHaveBeenLastCalledWith("-");
  });

  it("does not fire when the browser cancels the touch", () => {
    const onKey = renderKeys();
    fireEvent.pointerDown(key("Tab"), { pointerId: 1, clientY: 100 });
    fireEvent.pointerCancel(key("Tab"), { pointerId: 1 });
    fireEvent.pointerUp(key("Tab"), { pointerId: 1, clientY: 100 });
    expect(onKey).not.toHaveBeenCalled();
  });

  it("repeats arrows while held", () => {
    vi.useFakeTimers();
    const onKey = renderKeys();
    fireEvent.pointerDown(key("↑"), { pointerId: 1, clientY: 100 });
    expect(onKey).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(400 + 60 * 3));
    expect(onKey).toHaveBeenCalledTimes(4);
    fireEvent.pointerUp(key("↑"), { pointerId: 1, clientY: 100 });
    act(() => void vi.advanceTimersByTime(1000));
    expect(onKey).toHaveBeenCalledTimes(4);
    expect(onKey).toHaveBeenLastCalledWith("up");
  });

  it("shows the layers above with the pinned key", () => {
    const onKey = renderKeys();
    expect(screen.queryByRole("button", { name: "F1" })).toBeNull();
    tap(key("More keys"));
    expect(key("F1")).toBeTruthy();
    expect(key("Fewer keys").getAttribute("aria-pressed")).toBe("true");
    tap(key("Fewer keys"));
    expect(screen.queryByRole("button", { name: "F1" })).toBeNull();
    expect(onKey).not.toHaveBeenCalled();
  });

  it("hides the whole bar on a swipe down over the pinned key, and remembers it", () => {
    localStorage.removeItem("t.keys");
    const props = { base: TERMINAL_LAYOUT.base, more: TERMINAL_LAYOUT.more, latched: new Set<string>(), onKey: vi.fn(), label: "Extra keys", moreLabel: "More keys", lessLabel: "Fewer keys", showLabel: "Show keys", stateKey: "t.keys" };
    const { unmount } = render(<ExtraKeys {...props} />);
    tap(key("More keys"), 100, 130);
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(localStorage.getItem("t.keys")).toBe("hidden");
    unmount();
    render(<ExtraKeys {...props} />);
    fireEvent.click(key("Show keys"));
    expect(screen.getByRole("toolbar")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "F1" })).toBeNull();
    expect(props.onKey).not.toHaveBeenCalled();
  });

  it("marks latched modifiers", () => {
    renderKeys(vi.fn(), new Set(["ctrl"]));
    expect(key("Ctrl").getAttribute("aria-pressed")).toBe("true");
    expect(key("Alt").getAttribute("aria-pressed")).toBe("false");
  });
});
