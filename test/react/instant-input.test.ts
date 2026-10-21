// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { attachInstantInput } from "../../src/react/instantInput.js";

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function setup() {
  const element = document.createElement("div");
  const textarea = document.createElement("textarea");
  element.appendChild(textarea);
  document.body.appendChild(element);
  const xterm = vi.fn(); // stands in for xterm's own listeners on the textarea
  for (const type of ["compositionstart", "compositionupdate", "compositionend", "input", "keydown"]) textarea.addEventListener(type, xterm);
  const send = vi.fn();
  const detach = attachInstantInput({ textarea, element }, send);
  const type = (value: string, ev = "input") => {
    textarea.value = value;
    textarea.dispatchEvent(new Event(ev, { bubbles: true }));
  };
  return { textarea, send, xterm, detach, type, sent: () => send.mock.calls.map((c) => c[0] as string).join("") };
}

describe("instant input", () => {
  it("sends every letter of a composed word at once, and corrections as backspaces", () => {
    vi.useFakeTimers();
    const { textarea, send, xterm, type, sent } = setup();
    expect(textarea.value).toBe(" ");
    textarea.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    type(" t");
    type(" te");
    type(" teh", "compositionupdate");
    expect(sent()).toBe("teh");
    type(" the"); // the keyboard's correction
    type(" the", "compositionend");
    expect(sent()).toBe("teh\x7f\x7fhe");
    type(" the "); // the space after the word
    expect(sent()).toBe("teh\x7f\x7fhe ");
    vi.runAllTimers();
    expect(textarea.value).toBe(" "); // ready for the next word
    type(""); // Backspace eats the placeholder
    expect(sent().endsWith("\x7f")).toBe(true);
    expect(xterm).not.toHaveBeenCalled();
    expect(send.mock.calls.length).toBeGreaterThan(3);
  });

  it("leaves real keys to xterm and starts over after xterm empties the textarea", () => {
    const { textarea, xterm, type, sent } = setup();
    textarea.dispatchEvent(new KeyboardEvent("keydown", { keyCode: 13, bubbles: true }));
    expect(xterm).toHaveBeenCalledTimes(1);
    textarea.dispatchEvent(new KeyboardEvent("keydown", { keyCode: 229, bubbles: true }));
    expect(xterm).toHaveBeenCalledTimes(1);
    textarea.value = ""; // xterm on Enter
    textarea.dispatchEvent(new Event("beforeinput", { bubbles: true }));
    type("l");
    expect(sent()).toBe("l");
  });

  it("turns a newline into Enter and keeps emoji whole", () => {
    const { type, sent } = setup();
    type(" 👍");
    type(" 👍👋");
    type(" 👍");
    type(" 👍\n");
    expect(sent()).toBe("👍👋\x7f\r");
  });

  it("stops after detaching", () => {
    const { detach, type, send, xterm } = setup();
    detach();
    type(" x");
    expect(send).not.toHaveBeenCalled();
    expect(xterm).toHaveBeenCalled();
  });
});
