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
  const fire = (type: string) => textarea.dispatchEvent(new Event(type, { bubbles: true }));
  /** The textarea as the keyboard leaves it after an edit: text before and after the caret. */
  const edit = (before: string, after = PAD, ev = "input") => {
    textarea.value = before + after;
    textarea.setSelectionRange(before.length, before.length);
    fire(ev);
  };
  /** One Yandex Keyboard composition step, in the order logged on a phone. */
  const compose = (word: string) => {
    textarea.setSelectionRange(PAD.length, textarea.value.length - PAD.length); // Chrome selects the word first
    fire("compositionupdate");
    fire("beforeinput");
    edit(PAD + word);
  };
  const moveCaret = (pos: number) => {
    textarea.setSelectionRange(pos, pos);
    document.dispatchEvent(new Event("selectionchange"));
  };
  const sent = () => send.mock.calls.map((c) => c[0] as string).join("");
  return { textarea, xterm, keys, detach, fire, edit, compose, moveCaret, sent };
}

describe("instant input", () => {
  it("sends each letter of a word the keyboard composes, once", () => {
    vi.useFakeTimers();
    const { textarea, xterm, fire, compose, edit, sent, keys } = setup();
    expect(textarea.value).toBe(PAD + PAD);
    fire("compositionstart");
    compose("l");
    compose("ls");
    compose("ls"); // repeated updates with the same text
    compose("lsx");
    compose("ls"); // Backspace inside the word
    expect(sent()).toBe("lsx\x7f");
    compose("the");
    fire("compositionend");
    expect(sent()).toBe("lsx\x7f\x7f\x7fthe");
    edit(PAD + "the "); // the space after the word
    expect(sent()).toBe("lsx\x7f\x7f\x7fthe ");
    vi.runAllTimers();
    expect(textarea.value).toBe(PAD + PAD); // ready for the next word
    expect(xterm).not.toHaveBeenCalled();
    expect(keys).toEqual([]);
  });

  it("sends Backspace and Delete", () => {
    vi.useFakeTimers();
    const { edit, sent, keys } = setup();
    edit(PAD.slice(1)); // Backspace
    expect(sent()).toBe("\x7f");
    vi.runAllTimers();
    edit(PAD, PAD.slice(1)); // Delete
    expect(keys).toEqual(["del"]);
    expect(sent()).toBe("\x7f");
  });

  it("turns a caret the keyboard moves into Home, End or arrows", () => {
    const { moveCaret, keys, textarea } = setup();
    moveCaret(0);
    expect(keys).toEqual(["home"]);
    expect(textarea.selectionStart).toBe(PAD.length); // back in the middle
    moveCaret(PAD.length * 2);
    moveCaret(PAD.length - 1);
    moveCaret(PAD.length + 2);
    expect(keys).toEqual(["home", "end", "left", "right", "right"]);
    // a selection (the keyboard's select mode) is left alone
    textarea.setSelectionRange(2, 5);
    document.dispatchEvent(new Event("selectionchange"));
    expect(keys).toHaveLength(5);
  });

  it("ignores the caret while a word is composed", () => {
    const { fire, compose, moveCaret, keys } = setup();
    fire("compositionstart");
    compose("ls");
    moveCaret(0);
    expect(keys).toEqual([]);
  });

  it("leaves real keys to xterm and starts over after xterm empties the textarea", () => {
    const { textarea, xterm, edit, sent } = setup();
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", keyCode: 39, bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true }));
    expect(xterm).toHaveBeenCalledTimes(2);
    textarea.dispatchEvent(new KeyboardEvent("keydown", { keyCode: 229, bubbles: true }));
    expect(xterm).toHaveBeenCalledTimes(2);
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
    const { detach, edit, moveCaret, keys, xterm, sent } = setup();
    detach();
    edit(PAD + "x");
    moveCaret(0);
    expect(sent()).toBe("");
    expect(keys).toEqual([]);
    expect(xterm).toHaveBeenCalled();
  });
});
