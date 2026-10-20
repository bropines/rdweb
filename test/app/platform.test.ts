import { describe, expect, it } from "vitest";

import { detectInstallPlatform } from "../../app/src/platform.js";

const UA = {
  androidChrome: "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  samsung: "Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
  edgeAndroid: "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 EdgA/130.0.0.0",
  miui: "Mozilla/5.0 (Linux; U; Android 13; ru-ru; 2201117TY Build/TKQ1.221114.001) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/112.0.5615.136 Mobile Safari/537.36 XiaoMi/MiuiBrowser/14.8.0-gn",
  firefoxAndroid: "Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0",
  webview: "Mozilla/5.0 (Linux; Android 14; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  winEdge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  winFirefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
};

describe("detectInstallPlatform", () => {
  it("tells Chrome on Android from other Android browsers", () => {
    expect(detectInstallPlatform(UA.androidChrome)).toBe("android-chrome");
    for (const ua of [UA.samsung, UA.edgeAndroid, UA.miui, UA.firefoxAndroid, UA.webview]) expect(detectInstallPlatform(ua)).toBe("android-other");
  });

  it("recognises iOS, also iPadOS with a desktop user agent", () => {
    expect(detectInstallPlatform(UA.iphone)).toBe("ios");
    expect(detectInstallPlatform(UA.iphoneChrome)).toBe("ios");
    expect(detectInstallPlatform(UA.macSafari, 5)).toBe("ios");
  });

  it("recognises desktop browsers", () => {
    expect(detectInstallPlatform(UA.macSafari)).toBe("macos-safari");
    expect(detectInstallPlatform(UA.macChrome)).toBe("desktop-chromium");
    expect(detectInstallPlatform(UA.winEdge)).toBe("desktop-chromium");
    expect(detectInstallPlatform(UA.winFirefox)).toBe("firefox");
    expect(detectInstallPlatform("curl/8.0")).toBe("other");
  });
});
