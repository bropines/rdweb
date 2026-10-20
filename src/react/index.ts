// rdweb/react: the remote desktop UI as React components (Tailwind + shadcn/ui
// styling, Radix primitives). React, Radix, lucide-react and sonner are peer
// dependencies so the host shares one copy.
export { RemoteDesktop } from "./RemoteDesktop.js";
export type { RemoteDesktopProps, RemoteDesktopCredentials } from "./RemoteDesktop.js";
export { Toolbar, DEFAULT_PINNED_DESKTOP, DEFAULT_PINNED_TOUCH } from "./Toolbar.js";
export type { ActionId, ToolbarAction, ToolbarProps } from "./Toolbar.js";
export { SettingsSheet } from "./SettingsSheet.js";
export type { SettingsSheetProps } from "./SettingsSheet.js";
export { FilesSheet } from "./FilesSheet.js";
export { RemoteTerminal } from "./RemoteTerminal.js";
export type { FilesSheetProps } from "./FilesSheet.js";
export { Toaster } from "./Toaster.js";
export { ZipWriter, ZipTooLargeError, crc32 } from "./zip.js";
export { formatSize } from "./format.js";
export {
  DEFAULT_STORAGE_KEY,
  RDPANEL_STORAGE_KEY,
  loadRecent,
  pushRecent,
  loadPrefs,
  savePrefs,
  loadRememberedHash,
  saveRememberedHash,
  hasRememberedHash,
  migrateStorage,
  clearStoredData,
} from "./prefs.js";
export type { RecentPeer, ViewPrefs, ToolbarPrefs, WebClientPrefs } from "./prefs.js";
export { messages, createTranslator, resolveLang, I18nProvider, useI18n } from "./i18n/index.js";
export type { Messages, Lang, DeepPartial, Translate, TranslateOptions, I18nValue } from "./i18n/index.js";
export { cn } from "./lib/utils.js";
