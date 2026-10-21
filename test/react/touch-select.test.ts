import { describe, expect, it, vi } from "vitest";

import { extendFrom, selectBetween, wordAt } from "../../src/react/touchSelect.js";

/** A fake terminal over plain text lines ("你" takes two cells, the second of width 0). */
function fake(lines: string[], cols = 20) {
  const cells = lines.map((l) => {
    const row: { ch: string; w: number }[] = [];
    for (const ch of l) {
      if (ch === "你") row.push({ ch, w: 2 }, { ch: "", w: 0 });
      else row.push({ ch, w: 1 });
    }
    return row;
  });
  return {
    cols,
    rows: lines.length,
    buffer: {
      active: {
        viewportY: 0,
        getLine: (y: number) =>
          cells[y] && { getCell: (x: number) => (cells[y]![x] ? { getChars: () => cells[y]![x]!.ch, getWidth: () => cells[y]![x]!.w } : undefined) },
      },
    },
    select: vi.fn(),
  };
}

describe("touch selection", () => {
  it("finds the word under a cell, a blank cell alone", () => {
    const t = fake(["ls -la /var/log", "  你好 world"]);
    expect(wordAt(t, { col: 1, row: 0 })).toEqual({ start: { col: 0, row: 0 }, end: { col: 1, row: 0 } });
    expect(wordAt(t, { col: 9, row: 0 })).toEqual({ start: { col: 7, row: 0 }, end: { col: 14, row: 0 } });
    expect(wordAt(t, { col: 2, row: 0 })).toEqual({ start: { col: 2, row: 0 }, end: { col: 2, row: 0 } });
    expect(wordAt(t, { col: 3, row: 1 })).toEqual({ start: { col: 2, row: 1 }, end: { col: 4, row: 1 } }); // 你 spans 2-3, 好 is 4
  });

  it("selects across lines in either direction, keeping the pressed word", () => {
    const t = fake(["one two", "three"], 10);
    selectBetween(t, { col: 4, row: 0 }, { col: 2, row: 1 });
    expect(t.select).toHaveBeenLastCalledWith(4, 0, 10 + 2 - 4 + 1);
    selectBetween(t, { col: 2, row: 1 }, { col: 4, row: 0 });
    expect(t.select).toHaveBeenLastCalledWith(4, 0, 9);
    const word = { start: { col: 4, row: 0 }, end: { col: 6, row: 0 } };
    expect(extendFrom(word, { col: 0, row: 0 })).toEqual([{ col: 0, row: 0 }, { col: 6, row: 0 }]);
    expect(extendFrom(word, { col: 3, row: 1 })).toEqual([{ col: 4, row: 0 }, { col: 3, row: 1 }]);
    expect(extendFrom(word, { col: 5, row: 0 })).toEqual([word.start, word.end]);
  });
});
