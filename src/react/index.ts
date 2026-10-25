// rdweb/react: the remote desktop UI as React components (Tailwind + shadcn/ui
// styling, Radix primitives). React, Radix, lucide-react and sonner are peer
// dependencies so the host shares one copy.
export { RemoteDesktop } from "./RemoteDesktop.js";
export type { RemoteDesktopProps, RemoteDesktopCredentials } from "./RemoteDesktop.js";
export { Toolbar, DEFAULT_PINNED_DESKTOP, DEFAULT_PINNED_TOUCH } from "./Toolbar.js";
export type { ActionId, ToolbarAction, ToolbarProps } from "./Toolbar.js";
export { SettingsSheet, SettingsDialog, SettingsFields } from "./SettingsSheet.js";
export type { SettingsSheetProps, SettingsDialogProps, SettingsFieldsProps } from "./SettingsSheet.js";
export { ConnectionSettingsDialog } from "./ConnectionSettings.js";
export type { ConnectionSettingsDialogProps } from "./ConnectionSettings.js";
export { FilesSheet } from "./FilesSheet.js";
export { RemoteTerminal } from "./RemoteTerminal.js";
export { localShellStore } from "./shellStore.js";
export type { SavedShells, ShellStore } from "./shellStore.js";
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
  loadDevicePrefs,
  saveDevicePrefs,
  withDevicePrefs,
  devicePrefsOf,
  DEVICE_SETTING_KEYS,
  loadRememberedHash,
  saveRememberedHash,
  hasRememberedHash,
  migrateStorage,
  clearStoredData,
} from "./prefs.js";
export type { RecentPeer, ViewPrefs, ToolbarPrefs, WebClientPrefs, DevicePrefs } from "./prefs.js";
export { messages, createTranslator, resolveLang, I18nProvider, useI18n } from "./i18n/index.js";
export type { Messages, Lang, DeepPartial, Translate, TranslateOptions, I18nValue } from "./i18n/index.js";
export { cn } from "./lib/utils.js";
