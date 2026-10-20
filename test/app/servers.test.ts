import { describe, expect, it } from "vitest";

import { decodeConfigString, endpoints, entryFromConfig, hostOf, isIpHost, keyProblem, PUBLIC_SERVER, toServerConfig } from "../../app/src/servers.js";

const key = Buffer.alloc(32, 7).toString("base64");
// What RD Panel's Server page and the RustDesk client export: URL-safe base64 (no padding) of the JSON, reversed.
const encode = (o: object) => [...Buffer.from(JSON.stringify(o)).toString("base64url")].reverse().join("");

describe("RustDesk config strings", () => {
  const cfg = { host: "rd.example.com", relay: "rd.example.com", key, api: "https://rd.example.com" };

  it("decodes the reversed URL-safe base64 form, also inside a CLI line", () => {
    expect(decodeConfigString(encode(cfg))).toEqual(cfg);
    expect(decodeConfigString(`rustdesk --config "${encode(cfg)}"`)).toEqual(cfg);
    // the RustDesk client keeps the padding, which ends up in front
    const padded = [...Buffer.from(JSON.stringify({ host: "a.example", key })).toString("base64url").padEnd(64, "=")].reverse().join("");
    expect(decodeConfigString(padded).host).toBe("a.example");
  });

  it("accepts plain base64 and JSON, rejects other text", () => {
    expect(decodeConfigString(Buffer.from(JSON.stringify(cfg)).toString("base64")).key).toBe(key);
    expect(decodeConfigString(JSON.stringify({ host: "x.example", key })).host).toBe("x.example");
    expect(() => decodeConfigString("hello world")).toThrow();
    expect(() => decodeConfigString(encode({ foo: 1 }))).toThrow();
  });

  it("fills the form", () => {
    expect(entryFromConfig({ host: "rd.example.com:21116", relay: "rd.example.com:21117", key, api: "" })).toEqual({
      name: "rd.example.com",
      address: "rd.example.com",
      relay: undefined,
      key,
    });
    expect(entryFromConfig({ host: "id.example.com", relay: "relay.example.com", key, api: "" }).relay).toBe("relay.example.com");
    expect(entryFromConfig({ host: "", relay: "", key, api: "https://panel.example.com" }).address).toBe("panel.example.com");
    // a relay given as an IP address is a TCP endpoint, not a TLS proxy
    expect(entryFromConfig({ host: "id.example.com", relay: "203.0.113.5:21117", key, api: "" }).relay).toBeUndefined();
  });

  it("prefers the HTTPS API host: hbbs and hbbr addresses are TCP endpoints for native clients", () => {
    // what RD Panel exports when hbbs is published by IP and the relay by another name
    expect(entryFromConfig({ host: "203.0.113.5", relay: "desk.example.com:21117", key, api: "https://panel.example.com" })).toEqual({
      name: "panel.example.com",
      address: "panel.example.com",
      relay: undefined,
      key,
    });
    expect(entryFromConfig({ host: "id.example.com", relay: "", key, api: "http://panel.example.com" }).address).toBe("id.example.com");
    expect(entryFromConfig({ host: "id.example.com", relay: "", key, api: "https://203.0.113.5" }).address).toBe("id.example.com");
  });

  it("recognises IP addresses", () => {
    expect(isIpHost("203.0.113.5")).toBe(true);
    expect(isIpHost("203.0.113.5:8443")).toBe(true);
    expect(isIpHost("[2001:db8::1]:8443")).toBe(true);
    expect(isIpHost("2001:db8::1")).toBe(true);
    expect(isIpHost("rd.example.com")).toBe(false);
    expect(isIpHost("rd.example.com:8443")).toBe(false);
  });
});

describe("endpoints", () => {
  it("derives /ws/id and /ws/relay over TLS from a host", () => {
    expect(hostOf("https://RD.example.com/connect")).toBe("rd.example.com");
    expect(hostOf("rd.example.com:21116")).toBe("rd.example.com");
    expect(hostOf("rd.example.com:8443")).toBe("rd.example.com:8443");
    expect(endpoints("rd.example.com")).toEqual({ rendezvousUrl: "wss://rd.example.com/ws/id", relayUrl: "wss://rd.example.com/ws/relay" });
    expect(endpoints("rd.example.com", "relay.example.com")).toEqual({
      rendezvousUrl: "wss://rd.example.com/ws/id",
      relayUrl: "wss://relay.example.com/ws/relay",
    });
  });

  it("uses WebSocket URLs as given", () => {
    // without a relay, hbbr is reached next to hbbs, not at the relay hbbs announces
    expect(endpoints("wss://rd.example.com/custom/id")).toEqual({ rendezvousUrl: "wss://rd.example.com/custom/id", relayUrl: "wss://rd.example.com/ws/relay" });
    expect(endpoints("wss://rd.example.com:8443/ws/id")).toEqual({ rendezvousUrl: "wss://rd.example.com:8443/ws/id", relayUrl: "wss://rd.example.com:8443/ws/relay" });
    expect(toServerConfig({ id: "2", name: "y", address: "wss://a.example/ws/id", key }).relayUrl?.("other.example:21117")).toBe("wss://a.example/ws/relay");
    const s = toServerConfig({ id: "1", name: "x", address: "wss://a.example/ws/id", relay: "wss://b.example/r", key: ` ${key} ` });
    expect(s.rendezvousUrl).toBe("wss://a.example/ws/id");
    expect(s.relayUrl?.("b.example:21117")).toBe("wss://b.example/r");
    expect(s.key).toBe(key);
  });

  it("validates the server key", () => {
    expect(keyProblem(key)).toBeNull();
    expect(keyProblem("abc")).toMatch(/bytes|base64/);
  });
});

describe("RustDesk public server preset", () => {
  it("reaches the relay the ID server announces", () => {
    const c = toServerConfig(PUBLIC_SERVER);
    expect(c.rendezvousUrl).toBe("wss://rs-ny.rustdesk.com/ws/id");
    expect(c.relayUrl?.("rs-ny.rustdesk.com:21117")).toBe("wss://rs-ny.rustdesk.com/ws/relay");
    expect(keyProblem(c.key)).toBeNull();
  });
});
