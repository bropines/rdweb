// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { localShellStore } from "../../src/react/shellStore.js";

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
