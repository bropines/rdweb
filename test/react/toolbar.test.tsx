// @vitest-environment jsdom
import "./setup-dom.js";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Activity, Camera, FolderOpen, Settings2 } from "lucide-react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { splitToolbarActions, togglePinned, Toolbar, type ToolbarAction } from "../../src/react/Toolbar.js";

afterEach(cleanup);

const noop = () => {};
const actions = (run = vi.fn()): ToolbarAction[] => [
  { id: "settings", label: "Settings", icon: Settings2, run },
  { id: "files", label: "Files", icon: FolderOpen, run },
  { id: "stats", label: "Stats", icon: Activity, hidden: true, run },
  { id: "host-extra", label: "Host action", icon: Camera, run },
];

function renderBar(over: Partial<ComponentProps<typeof Toolbar>> = {}) {
  const props: ComponentProps<typeof Toolbar> = {
    actions: actions(),
    pinned: ["settings", "stats"],
    onPinned: vi.fn(),
    defaultPinned: ["settings"],
    keepOpen: true,
    onKeepOpen: vi.fn(),
    position: 0.5,
    onPosition: noop,
    title: "office-pc",
    subtitle: "123 · Windows",
    status: "ok",
    canCollapse: false,
    onDisconnect: vi.fn(),
    onLeave: vi.fn(),
    ended: false,
    ...over,
  };
  render(<Toolbar {...props} />);
  return props;
}

describe("toolbar logic", () => {
  it("splits pinned and menu actions, skipping hidden ones", () => {
    const { visible, pinned, rest } = splitToolbarActions(actions(), ["files", "stats", "gone"]);
    expect(visible.map((a) => a.id)).toEqual(["settings", "files", "host-extra"]);
    expect(pinned.map((a) => a.id)).toEqual(["files"]);
    expect(rest.map((a) => a.id)).toEqual(["settings", "host-extra"]);
  });

  it("puts force-pinned actions on the bar first while they are visible", () => {
    const list: ToolbarAction[] = [...actions(), { id: "sound", label: "Enable sound", icon: Camera, forcePinned: true, run: noop }];
    const { pinned, rest } = splitToolbarActions(list, ["files"]);
    expect(pinned.map((a) => a.id)).toEqual(["sound", "files"]);
    expect(rest.map((a) => a.id)).toEqual(["settings", "host-extra"]);
    list[4]!.hidden = true;
    expect(splitToolbarActions(list, ["files"]).pinned.map((a) => a.id)).toEqual(["files"]);
    // pinned explicitly: keeps its place
    list[4]!.hidden = false;
    expect(splitToolbarActions(list, ["files", "sound"]).pinned.map((a) => a.id)).toEqual(["files", "sound"]);
  });

  it("pins at the end and unpins", () => {
    expect(togglePinned(["a", "b"], "c", true)).toEqual(["a", "b", "c"]);
    expect(togglePinned(["a", "b"], "a", true)).toEqual(["b", "a"]);
    expect(togglePinned(["a", "b"], "a", false)).toEqual(["b"]);
  });
});

describe("<Toolbar>", () => {
  it("shows pinned actions on the bar and the rest in the menu", () => {
    const run = vi.fn();
    renderBar({ actions: actions(run) });
    const bar = screen.getByRole("toolbar", { name: "office-pc" });
    fireEvent.click(within(bar).getByRole("button", { name: "Settings" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(within(bar).queryByRole("button", { name: "Files" })).toBeNull();
    expect(within(bar).queryByRole("button", { name: "Stats" })).toBeNull();

    fireEvent.keyDown(within(bar).getByRole("button", { name: "More" }), { key: "Enter" });
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Files" })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "Host action" })).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: "Settings" })).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Files" }));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("customizes pinned actions and resets them", () => {
    const p = renderBar();
    fireEvent.keyDown(screen.getByRole("button", { name: "More" }), { key: "Enter" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Customize toolbar" }));
    const dialog = screen.getByRole("dialog", { name: "Customize toolbar" });
    const boxes = within(dialog).getAllByRole("checkbox");
    expect(boxes.map((b) => b.getAttribute("aria-label"))).toEqual(["Settings", "Files", "Host action"]);
    expect(boxes.map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Host action" }));
    expect(p.onPinned).toHaveBeenLastCalledWith(["settings", "stats", "host-extra"]);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Settings" }));
    expect(p.onPinned).toHaveBeenLastCalledWith(["stats"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset" }));
    expect(p.onPinned).toHaveBeenLastCalledWith(["settings"]);
  });

  it("toggles keep-open and switches disconnect to back when the session ended", () => {
    const p = renderBar({ keepOpen: false });
    fireEvent.click(screen.getByRole("button", { name: "Keep toolbar open" }));
    expect(p.onKeepOpen).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(p.onDisconnect).toHaveBeenCalled();
    cleanup();
    const q = renderBar({ ended: true, status: "error" });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(q.onLeave).toHaveBeenCalled();
  });
});
