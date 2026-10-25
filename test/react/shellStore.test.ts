// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { closeAction, localShellStore } from "../../src/react/shellStore.js";

describe("localShellStore", () => {
  beforeEach(() => localStorage.clear());

  it("keeps the newest sessions per server and device", async () => {
    const a = localShellStore("rdweb", "KEY", "123");
    const other = localShellStore("rdweb", "KEY", "456");
    for (let i = 0; i < 12; i++) await a.save({ serviceId: `s${i}`, tabs: 1, createdAt: i, updatedAt: i });
    await other.save({ serviceId: "x", tabs: 2, createdAt: 1, updatedAt: 1 });
    const list = await a.list();
    expect(list.map((s) => s.serviceId)).toEqual(["s11", "s10", "s9", "s8", "s7", "s6", "s5", "s4", "s3", "s2"]);
    expect((await other.list()).map((s) => s.serviceId)).toEqual(["x"]);

    await a.save({ serviceId: "s5", tabs: 3, createdAt: 5, updatedAt: 99 }); // update moves it first
    expect((await a.list())[0]).toMatchObject({ serviceId: "s5", tabs: 3 });
    await a.remove("s5");
    expect((await a.list()).some((s) => s.serviceId === "s5")).toBe(false);
  });
});

describe("closeAction", () => {
  const live = { persistent: true, shellsEnded: false };

  it("regression: a dropped connection must not forget the shells", () => {
    // what the connector reports when an established link drops (sleep, relay idle timeout)
    expect(closeAction({ reason: "connection lost", remote: true, retryable: true }, live)).toBe("retry");
  });

  it("retries a retryable close that was not remote either", () => {
    expect(closeAction({ reason: "x", remote: false, retryable: true }, live)).toBe("retry");
  });

  it("forgets the record when a non-retryable close followed the shells ending", () => {
    for (const remote of [true, false]) {
      expect(closeAction({ reason: "exit", remote, retryable: false }, { persistent: true, shellsEnded: true })).toBe("forget");
    }
  });

  it("keeps the record on a non-retryable close that may have left shells alive", () => {
    for (const remote of [true, false]) {
      expect(closeAction({ reason: "refused", remote, retryable: false }, live)).toBe("keep");
    }
  });

  it("forgets whatever the info says when the session is not persistent", () => {
    for (const remote of [true, false])
      for (const retryable of [true, false])
        for (const shellsEnded of [true, false])
          expect(closeAction({ reason: "x", remote, retryable }, { persistent: false, shellsEnded })).toBe("forget");
  });
});
