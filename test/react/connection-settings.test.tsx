// @vitest-environment jsdom
import "./setup-dom.js";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectionSettingsDialog } from "../../src/react/ConnectionSettings.js";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("<ConnectionSettingsDialog>", () => {
  it("edits the default connection settings and can reset them", () => {
    const onOpenChange = vi.fn();
    render(<ConnectionSettingsDialog open onOpenChange={onOpenChange} storageKey="app" />);
    const dialog = screen.getByRole("dialog", { name: "Default connection settings" });
    fireEvent.click(within(dialog).getByRole("switch", { name: "Mute" }));
    expect(JSON.parse(localStorage.getItem("app.prefs")!).settings.disableAudio).toBe(true);
    // the session-only choices are not offered here
    expect(within(dialog).queryByRole("switch", { name: "View only" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset all" }));
    expect(JSON.parse(localStorage.getItem("app.prefs")!).settings.disableAudio).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("follows the language", () => {
    render(<ConnectionSettingsDialog open onOpenChange={vi.fn()} lang="ru" />);
    expect(screen.getByRole("dialog", { name: "Настройки подключения по умолчанию" })).toBeTruthy();
  });
});
