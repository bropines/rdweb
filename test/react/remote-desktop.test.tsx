// @vitest-environment jsdom
import "./setup-dom.js";

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PeerSummary, SessionOptions } from "../../src/index.js";

// A scripted stand-in for the protocol Session and the DOM Viewer.
const fakes = vi.hoisted(() => {
  type Handler = (payload: unknown) => void;
  class FakeSession {
    static all: FakeSession[] = [];
    handlers = new Map<string, Set<Handler>>();
    permission = { keyboard: true, clipboard: true, audio: true, file: true, restart: true, recording: true, blockInput: true, privacyMode: true };
    connect = vi.fn(() => new Promise<void>(() => {}));
    login = vi.fn(async (_pw: string) => {});
    close = vi.fn();
    updateSettings = vi.fn();
    submitTwoFactor = vi.fn();
    resumeAudio = vi.fn();
    switchDisplay = vi.fn();
    audioState = "off";
    constructor(public opts: SessionOptions) {
      FakeSession.all.push(this);
    }
    on(ev: string, fn: Handler) {
      if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
      this.handlers.get(ev)!.add(fn);
      return () => this.handlers.get(ev)!.delete(fn);
    }
    emit(ev: string, payload: unknown = {}) {
      for (const fn of this.handlers.get(ev) ?? []) fn(payload);
    }
  }
  class FakeViewer {
    constructor(
      public el: HTMLElement,
      public session: unknown,
    ) {}
    on() {
      return () => {};
    }
    getInputMode() {
      return "mouse";
    }
    setInputMode() {}
    setScaleMode() {}
    setZoomCursor() {}
    setSoftKeyHandler() {}
    focus() {}
    destroy() {}
  }
  class FakeFileTransfer {
    static all: FakeFileTransfer[] = [];
    handlers = new Map<string, Set<Handler>>();
    peer: unknown = null;
    connect = vi.fn(() => new Promise<void>(() => {}));
    login = vi.fn(async (_pw: string) => {});
    close = vi.fn();
    constructor() {
      FakeFileTransfer.all.push(this);
    }
    on(ev: string, fn: Handler) {
      if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
      this.handlers.get(ev)!.add(fn);
      return () => this.handlers.get(ev)!.delete(fn);
    }
    emit(ev: string, payload: unknown = {}) {
      for (const fn of this.handlers.get(ev) ?? []) fn(payload);
    }
  }
  return { FakeSession, FakeViewer, FakeFileTransfer };
});

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", async (importOriginal) => ({ ...(await importOriginal<typeof import("sonner")>()), toast }));

vi.mock("../../src/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/index.js")>()),
  Session: fakes.FakeSession,
  Viewer: fakes.FakeViewer,
  FileTransferSession: fakes.FakeFileTransfer,
  isWebCodecsAvailable: () => true,
}));

const { RemoteDesktop, loadRecent, loadRememberedHash } = await import("../../src/react/index.js");

const server = { rendezvousUrl: "wss://rd.example.com/ws/id", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" };
const peer: PeerSummary = {
  id: "123456789",
  username: "user",
  hostname: "office-pc",
  platform: "Windows",
  os: "windows",
  version: "1.4.2",
  displays: [],
  currentDisplay: 0,
  resolutions: [],
  codecs: [],
  codecs444: [],
  privacyModeSupported: false,
  sasEnabled: false,
  windowsSessions: [],
  currentWindowsSession: 0,
};
const session = () => fakes.FakeSession.all.at(-1)!;

beforeEach(() => {
  localStorage.clear();
  fakes.FakeSession.all = [];
  toast.mockClear();
});
afterEach(cleanup);

describe("<RemoteDesktop>", () => {
  it("asks for the password, remembers the login and reports the session", async () => {
    const onRemembered = vi.fn(async () => {});
    const onConnected = vi.fn();
    render(<RemoteDesktop peerId="123456789" server={server} onLeave={vi.fn()} onRemembered={onRemembered} onConnected={onConnected} />);
    expect(session().opts.peerId).toBe("123456789");
    expect(session().connect).toHaveBeenCalled();
    expect(screen.getByRole("toolbar", { name: "123456789" })).toBeTruthy();
    expect(screen.getAllByText("Starting…").length).toBeGreaterThan(0);

    act(() => session().emit("password", { wrong: false }));
    const dialog = screen.getByRole("dialog", { name: "Password required" });
    fireEvent.change(within(dialog).getByLabelText("Remote device password"), { target: { value: "secret" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Remember password" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(session().login).toHaveBeenCalledWith("secret");

    const hash = new Uint8Array([9, 8, 7]);
    act(() => session().emit("state", { state: "connected" }));
    await act(async () => session().emit("connected", { peer, rememberedHash: hash }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onRemembered).toHaveBeenCalledWith(hash);
    expect(onConnected).toHaveBeenCalledWith(peer);
    expect(localStorage.getItem(`rdweb.pw.${server.key.slice(0, 16)}.123456789`)).toBe(JSON.stringify("CQgH"));
    expect(JSON.parse(localStorage.getItem("rdweb.recent")!)[0]).toMatchObject({ id: "123456789", name: "office-pc" });
    expect(screen.getByRole("toolbar", { name: "office-pc" })).toBeTruthy();
  });

  it("tries the host's saved logins before asking", () => {
    const onForget = vi.fn();
    const rememberedHash = new Uint8Array([1, 2, 3]);
    render(
      <RemoteDesktop
        peerId="42"
        server={server}
        onLeave={vi.fn()}
        onForget={onForget}
        credentials={{ rememberedHash, password: "from-book", fromPersonalBook: true }}
        storageKey="host"
      />,
    );
    expect(session().opts.rememberedHash).toEqual(rememberedHash);
    // the hash is rejected: the shared password is tried silently
    act(() => session().emit("password", { wrong: true }));
    expect(session().login).toHaveBeenCalledWith("from-book");
    expect(screen.queryByRole("dialog")).toBeNull();
    // that fails too: ask, and let the host drop the stale hash
    act(() => session().emit("password", { wrong: true }));
    expect(screen.getByRole("dialog", { name: "Password required" })).toBeTruthy();
    expect(screen.getByText("Wrong password, try again.")).toBeTruthy();
    expect(onForget).toHaveBeenCalledTimes(1);
  });

  it("prefers the hash remembered in this browser and follows lang/messages", () => {
    localStorage.setItem(`rdpanel.webclient.pw.${server.key.slice(0, 16)}.7`, JSON.stringify("AQID"));
    localStorage.setItem("rdpanel_pwd_7", "plaintext");
    const onLeave = vi.fn();
    render(
      <RemoteDesktop
        peerId="7"
        server={server}
        lang="ru"
        messages={{ toolbar: { back: "Вернуться в панель" } }}
        rememberLabel="Запомнить в моём аккаунте"
        storageKey="rdpanel.webclient"
        credentials={{ rememberedHash: new Uint8Array([5]) }}
        onLeave={onLeave}
      />,
    );
    expect(session().opts.rememberedHash).toEqual(new Uint8Array([1, 2, 3]));
    expect(localStorage.getItem("rdpanel_pwd_7")).toBeNull();
    expect(screen.getAllByText("Запуск…").length).toBeGreaterThan(0);

    act(() => session().emit("password", { wrong: true }));
    expect(localStorage.getItem(`rdpanel.webclient.pw.${server.key.slice(0, 16)}.7`)).toBeNull();
    const dialog = screen.getByRole("dialog", { name: "Нужен пароль" });
    expect(within(dialog).getByRole("checkbox", { name: "Запомнить в моём аккаунте" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));
    expect(session().close).toHaveBeenCalledWith("Отменено");

    act(() => session().emit("close", { reason: "x", remote: false, retryable: true }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Ещё" }), { key: "Enter" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Вернуться в панель" }));
    expect(onLeave).toHaveBeenCalled();

    // reconnecting remounts with a fresh session
    const before = fakes.FakeSession.all.length;
    fireEvent.click(screen.getByRole("button", { name: "Переподключиться" }));
    expect(fakes.FakeSession.all.length).toBe(before + 1);
  });

  it("offers to enable sound while the browser blocks it", () => {
    render(<RemoteDesktop peerId="1" server={server} onLeave={vi.fn()} />);
    act(() => session().emit("state", { state: "connected" }));
    act(() => session().emit("connected", { peer, rememberedHash: null }));
    const bar = () => screen.getByRole("toolbar", { name: "office-pc" });
    expect(within(bar()).queryByRole("button", { name: "Enable sound" })).toBeNull();

    act(() => session().emit("audio", { state: "blocked" }));
    // on the bar although it was never pinned
    fireEvent.click(within(bar()).getByRole("button", { name: "Enable sound" }));
    expect(session().resumeAudio).toHaveBeenCalledTimes(1);
    const blocked = toast.mock.calls.filter(([msg]) => String(msg).startsWith("Sound is blocked by the browser"));
    expect(blocked).toHaveLength(1);

    act(() => session().emit("audio", { state: "playing" }));
    expect(within(bar()).queryByRole("button", { name: "Enable sound" })).toBeNull();
    act(() => session().emit("audio", { state: "blocked" }));
    expect(within(bar()).getByRole("button", { name: "Enable sound" })).toBeTruthy();
    // the toast is shown once per session
    expect(toast.mock.calls.filter(([msg]) => String(msg).startsWith("Sound is blocked"))).toHaveLength(1);
  });
  it("remembers a device opened for files only among the recent ones", async () => {
    localStorage.clear();
    const onConnected = vi.fn();
    render(<RemoteDesktop peerId="555666777" mode="files" server={server} onLeave={vi.fn()} onConnected={onConnected} />);
    const ft = fakes.FakeFileTransfer.all.at(-1)!;
    ft.peer = { id: "555666777", username: "u", hostname: "nas", platform: "Linux", os: "linux", version: "1.4.2", separator: "/" };
    await act(async () => ft.emit("connected", { home: null }));
    expect(onConnected).toHaveBeenCalledWith(expect.objectContaining({ id: "555666777", hostname: "nas", displays: [] }));
    expect(loadRecent().map((r) => r.id)).toContain("555666777");
  });
  it("offers to remember the password in the files only mode", async () => {
    localStorage.clear();
    const onRemembered = vi.fn();
    render(<RemoteDesktop peerId="555666777" mode="files" server={server} onLeave={vi.fn()} onRemembered={onRemembered} />);
    const ft = fakes.FakeFileTransfer.all.at(-1)!;
    await act(async () => ft.emit("password", { wrong: false }));
    fireEvent.change(screen.getByLabelText("Remote device password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Remember password/ }));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(ft.login).toHaveBeenCalledWith("secret");
    const hash = new Uint8Array([1, 2, 3]);
    await act(async () => ft.emit("connected", { home: null, rememberedHash: hash }));
    expect(onRemembered).toHaveBeenCalledWith(hash);
    expect(loadRememberedHash(server.key, "555666777")).toEqual(hash);
  });
  it("keeps what a session changes for that device and can reset it to the defaults", async () => {
    localStorage.setItem("rdweb.prefs", JSON.stringify({ settings: { codec: "av1" } }));
    render(<RemoteDesktop peerId="777" server={server} onLeave={vi.fn()} />);
    expect(session().opts.settings).toMatchObject({ codec: "av1" });
    act(() => session().emit("state", { state: "connected" }));
    await act(async () => session().emit("connected", { peer, rememberedHash: null }));
    fireEvent.click(screen.getAllByRole("button", { name: "Session settings" })[0]!);
    const sheet = screen.getByRole("dialog", { name: "Session settings" });
    expect(within(sheet).getByText(/uses the default settings/)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("switch", { name: "Mute" }));
    expect(session().updateSettings).toHaveBeenLastCalledWith({ disableAudio: true });
    const own = JSON.parse(localStorage.getItem(`rdweb.device.${server.key.slice(0, 16)}.777`)!);
    expect(own).toEqual({ settings: { disableAudio: true } });
    expect(JSON.parse(localStorage.getItem("rdweb.prefs")!).settings).toMatchObject({ codec: "av1", disableAudio: false }); // the defaults stay
    fireEvent.click(within(sheet).getByRole("button", { name: "Reset to the defaults" }));
    expect(session().updateSettings).toHaveBeenLastCalledWith(expect.objectContaining({ codec: "av1", disableAudio: false }));
    expect(localStorage.getItem(`rdweb.device.${server.key.slice(0, 16)}.777`)).toBeNull();
    cleanup();
    // another device starts from the defaults
    render(<RemoteDesktop peerId="888" server={server} onLeave={vi.fn()} />);
    expect(session().opts.settings).toMatchObject({ codec: "av1", disableAudio: false });
  });
  it("picks a monitor straight from a list and switches to that one", async () => {
    const monitors = [
      { index: 0, x: 0, y: 0, width: 1920, height: 1080, name: "\\\\.\\DISPLAY1", online: true, cursorEmbedded: false, originalWidth: 0, originalHeight: 0, scale: 1 },
      { index: 1, x: 1920, y: 0, width: 2560, height: 1440, name: "\\\\.\\DISPLAY2", online: true, cursorEmbedded: false, originalWidth: 0, originalHeight: 0, scale: 1 },
      { index: 2, x: 4480, y: 0, width: 1280, height: 1024, name: "", online: true, cursorEmbedded: false, originalWidth: 0, originalHeight: 0, scale: 1 },
    ];
    render(<RemoteDesktop peerId="1" server={server} onLeave={vi.fn()} />);
    const bar = () => screen.getByRole("toolbar", { name: "office-pc" });
    act(() => session().emit("state", { state: "connected" }));
    // one monitor: no picker on the bar
    await act(async () => session().emit("connected", { peer: { ...peer, displays: monitors.slice(0, 1) }, rememberedHash: null }));
    expect(within(bar()).queryByRole("button", { name: /^Monitor \(/ })).toBeNull();

    await act(async () => session().emit("connected", { peer: { ...peer, displays: monitors, currentDisplay: 1 }, rememberedHash: null }));
    act(() => session().emit("display", { display: monitors[1], resolutions: [] }));
    // pinned by default, so it is on the bar itself
    fireEvent.click(within(bar()).getByRole("button", { name: "Monitor (2 of 3)" }));
    const dlg = screen.getByRole("dialog", { name: "Monitor" });
    const options = within(dlg).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["1 · DISPLAY1 (1920×1080)", "2 · DISPLAY2 (2560×1440)", "3 (1280×1024)"]);
    expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);

    // the current one: just closes
    fireEvent.click(options[1]!);
    expect(session().switchDisplay).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Monitor" })).toBeNull();

    // straight to the third, not through the next one
    fireEvent.click(within(bar()).getByRole("button", { name: "Monitor (2 of 3)" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Monitor" })).getByRole("option", { name: /^3/ }));
    expect(session().switchDisplay).toHaveBeenCalledTimes(1);
    expect(session().switchDisplay).toHaveBeenCalledWith(2);
    expect(screen.queryByRole("dialog", { name: "Monitor" })).toBeNull();
  });
});
