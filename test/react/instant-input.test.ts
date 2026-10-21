// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { attachInstantInput } from "../../src/react/instantInput.js";

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

const PAD = " ".repeat(8);

function setup() {
  const element = document.createElement("div");
  const textarea = document.createElement("textarea");
  element.appendChild(textarea);
  document.body.appendChild(element);
  const xterm = vi.fn(); // stands in for xterm's own listeners on the textarea
  for (const type of ["compositionstart", "compositionupdate", "compositionend", "input", "keydown"]) textarea.addEventListener(type, xterm);
  const send = vi.fn();
  const keys: string[] = [];
  const detach = attachInstantInput({ textarea, element }, send, (k) => keys.push(k));
  textarea.focus();
  /** The textarea as the keyboard leaves it: text before and after the caret. */
  const edit = (before: string, after = PAD, ev = "input") => {
    textarea.value = before + after;
    textarea.setSelectionRange(before.length, before.length);
    textarea.dispatchEvent(new Event(ev, { bubbles: true }));
  };
  const moveCaret = (pos: number) => {
    textarea.setSelectionRange(pos, pos);
    document.dispatchEvent(new Event("selectionchange"));
  };
  return { textarea, send, keys, xterm, detach, edit, moveCaret, sent: () => send.mock.calls.map((c) => c[0] as string).join("") };
}

describe("instant input", () => {
  it("sends every letter of a composed word at once, and corrections as backspaces", () => {
    vi.useFakeTimers();
    const { textarea, xterm, edit, sent, keys } = setup();
    expect(textarea.value).toBe(PAD + PAD);
    textarea.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    edit(PAD + "t");
    edit(PAD + "te");
    edit(PAD + "teh", PAD, "compositionupdate");
    expect(sent()).toBe("teh");
    edit(PAD + "the"); // the keyboard's correction
    edit(PAD + "the", PAD, "compositionend");
    expect(sent()).toBe("teh\x7f\x7fhe");
    edit(PAD + "the "); // the space after the word
    expect(sent()).toBe("teh\x7f\x7fhe ");
    vi.runAllTimers();
    expect(textarea.value).toBe(PAD + PAD); // ready for the next word
    expect(textarea.selectionStart).toBe(PAD.length);
    expect(xterm).not.toHaveBeenCalled();
    expect(keys).toEqual([]);
  });

  it("tells Backspace from Delete by the caret", () => {
    vi.useFakeTimers();
    const { edit, sent, keys } = setup();
    edit(PAD.slice(1)); // Backspace
    expect(sent()).toBe("\x7f");
    vi.runAllTimers();
    edit(PAD, PAD.slice(1)); // Delete
    expect(keys).toEqual(["del"]);
    expect(sent()).toBe("\x7f");
  });

  it("turns the keyboard's cursor keys into arrows, Home and End", () => {
    const { moveCaret, keys, send, textarea } = setup();
    moveCaret(PAD.length - 1);
    expect(keys).toEqual(["left"]);
    expect(textarea.selectionStart).toBe(PAD.length); // back in the middle
    moveCaret(PAD.length + 2);
    expect(keys).toEqual(["left", "right", "right"]);
    moveCaret(0);
    moveCaret(PAD.length * 2);
    expect(keys).toEqual(["left", "right", "right", "home", "end"]);
    // a selection (the keyboard's select mode) is left alone
    textarea.setSelectionRange(2, 5);
    document.dispatchEvent(new Event("selectionchange"));
    expect(keys).toHaveLength(5);
    expect(send).not.toHaveBeenCalled();
  });

  it("leaves real keys to xterm and starts over after xterm empties the textarea", () => {
    const { textarea, xterm, edit, sent } = setup();
    textarea.dispatchEvent(new KeyboardEvent("keydown", { keyCode: 13, bubbles: true }));
    expect(xterm).toHaveBeenCalledTimes(1);
    textarea.dispatchEvent(new KeyboardEvent("keydown", { keyCode: 229, bubbles: true }));
    expect(xterm).toHaveBeenCalledTimes(1);
    textarea.value = ""; // xterm on Enter
    textarea.dispatchEvent(new Event("beforeinput", { bubbles: true }));
    edit("l", "");
    expect(sent()).toBe("l");
  });

  it("turns a newline into Enter and keeps emoji whole", () => {
    const { edit, sent } = setup();
    edit(PAD + "👍");
    edit(PAD + "👍👋");
    edit(PAD + "👍");
    edit(PAD + "👍\n");
    expect(sent()).toBe("👍👋\x7f\r");
  });

  it("stops after detaching", () => {
    const { detach, edit, send, xterm, moveCaret, keys } = setup();
    detach();
    edit(PAD + "x");
    moveCaret(1);
    expect(send).not.toHaveBeenCalled();
    expect(keys).toEqual([]);
    expect(xterm).toHaveBeenCalled();
  });
});
