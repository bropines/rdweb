// Which browser and system the page runs in, for the install instructions.

export type InstallPlatform = "android-chrome" | "android-other" | "ios" | "macos-safari" | "desktop-chromium" | "firefox" | "other";

/** Every platform with its own instructions, in the order the install dialog lists them. */
export const INSTALL_PLATFORMS: readonly InstallPlatform[] = ["android-chrome", "android-other", "ios", "macos-safari", "desktop-chromium", "firefox"];

// Chromium-based Android browsers with their own install flow (and WebViews).
const ANDROID_NOT_CHROME = /EdgA\/|SamsungBrowser\/|OPR\/|OPX\/|Opera|YaBrowser\/|YaApp|Vivaldi\/|DuckDuckGo\/|MiuiBrowser\/|HeyTapBrowser\/|UCBrowser\/|Firefox\/|; wv\)|Version\/\d/;

export function detectInstallPlatform(ua: string, maxTouchPoints = 0): InstallPlatform {
  if (/Android/i.test(ua)) return /Chrome\/\d/.test(ua) && !ANDROID_NOT_CHROME.test(ua) ? "android-chrome" : "android-other";
  // iPadOS reports a Mac unless it is asked for the mobile site
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) return "ios";
  if (/Firefox\//.test(ua)) return "firefox";
  if (/Macintosh/.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua) && /Version\/[\d.]+.*Safari\//.test(ua)) return "macos-safari";
  if (/Chrome\/|Chromium\/|Edg\//.test(ua)) return "desktop-chromium";
  return "other";
}

export function isAndroid(p: InstallPlatform): boolean {
  return p === "android-chrome" || p === "android-other";
}
