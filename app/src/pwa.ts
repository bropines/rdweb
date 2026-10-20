// Installing the app and keeping it up to date: the service worker (app/sw.js)
// and the browser's install prompt.
import { useSyncExternalStore } from "react";

import { BUILD } from "./build";

const BASE = import.meta.env.BASE_URL;
const UPDATE_CHECK_MS = 60 * 60 * 1000;

function store() {
  const listeners = new Set<() => void>();
  return {
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    emit: () => listeners.forEach((l) => l()),
  };
}

// --- service worker and updates ---

const updates = store();
let waiting: ServiceWorker | null = null;
let reloadOnTakeover = false;

/** Registers /rdweb/sw.js (production builds, https or localhost only). */
export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  if (location.protocol !== "https:" && !local) return;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadOnTakeover) location.reload();
  });
  const register = () => {
    navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE }).then(watch, (e: unknown) => console.warn("rdweb: service worker registration failed", e));
  };
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}

function watch(reg: ServiceWorkerRegistration): void {
  // a worker that waits while an older one controls this page is an update
  const installed = (sw: ServiceWorker) => {
    if (navigator.serviceWorker.controller) void offerUpdate(sw);
  };
  if (reg.waiting) installed(reg.waiting);
  reg.addEventListener("updatefound", () => {
    const sw = reg.installing;
    sw?.addEventListener("statechange", () => {
      if (sw.state === "installed") installed(sw);
    });
  });
  // tabs that stay open for days still learn about new deploys
  window.setInterval(() => void reg.update().catch(() => {}), UPDATE_CHECK_MS);
}

async function offerUpdate(sw: ServiceWorker): Promise<void> {
  // Navigations are network-first, so this page may already be the new build:
  // then the new worker takes over quietly.
  if ((await workerVersion(sw)) === BUILD.id) {
    sw.postMessage({ type: "skip-waiting" });
    return;
  }
  waiting = sw;
  updates.emit();
}

function workerVersion(sw: ServiceWorker): Promise<string | null> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = window.setTimeout(() => resolve(null), 3000);
    channel.port1.onmessage = (e: MessageEvent) => {
      window.clearTimeout(timer);
      resolve(typeof e.data === "string" ? e.data : null);
    };
    sw.postMessage({ type: "version" }, [channel.port2]);
  });
}

/** True once a new version is installed and waits for this page to reload. */
export function useUpdateReady(): boolean {
  return useSyncExternalStore(updates.subscribe, () => waiting !== null);
}

/** Activates the waiting version and reloads the page into it. */
export function applyUpdate(): void {
  if (!waiting || waiting.state !== "installed") {
    location.reload(); // another tab already switched to it
    return;
  }
  reloadOnTakeover = true;
  waiting.postMessage({ type: "skip-waiting" });
  window.setTimeout(() => location.reload(), 3000); // should the takeover never be reported
}

// --- install ---

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
  userChoice?: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * "prompt": the browser's own install prompt is ready; "manual": only
 * instructions (Safari, Firefox, or Chrome did not offer to install, e.g. when
 * its WebAPK service is unreachable); "hidden": installed or running as an app.
 */
export type InstallState = "prompt" | "manual" | "hidden";

const install = store();
let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;

/** Catches Chromium's install prompt for the header button; call early. */
export function listenForInstall(): void {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // our button instead of the mini-infobar
    deferred = e as BeforeInstallPromptEvent;
    install.emit();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installed = true;
    install.emit();
  });
  window.matchMedia?.("(display-mode: standalone)").addEventListener?.("change", install.emit);
}

function standalone(): boolean {
  return !!window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

function installState(): InstallState {
  if (installed || standalone()) return "hidden";
  return deferred ? "prompt" : "manual";
}

/** Whether to show the Install button, and whether the browser's own prompt is available. */
export function useInstallState(): InstallState {
  return useSyncExternalStore(install.subscribe, installState);
}

/** Shows the browser's install prompt (state "prompt"); true if the user accepted. */
export async function promptInstall(): Promise<boolean> {
  const e = deferred;
  if (!e) return false;
  deferred = null; // one prompt per event; the browser fires a new one when it may ask again
  install.emit();
  await e.prompt();
  const choice = await e.userChoice?.catch(() => null);
  return choice?.outcome === "accepted";
}
