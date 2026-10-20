export { Session, SessionError, CLIENT_VERSION, MOUSE_BUTTON, MOUSE_TYPE } from "./session.js";
export type { KeyInput, MouseButtonName } from "./session.js";
export { Viewer, normalizeWheel } from "./viewer.js";
export type { InputMode, ScaleMode, ViewerOptions, ViewerEventMap } from "./viewer.js";
export { probeCodecs, isWebCodecsAvailable, ALL_CODECS } from "./video.js";
export type { Codec, CodecSupport } from "./video.js";
export { isAudioDecodingAvailable } from "./audio.js";
export type { AudioState } from "./audio.js";
export { encodeBase64, decodeBase64, parseServerKey } from "./crypto.js";
export { DEFAULT_SETTINGS } from "./types.js";
export type {
  CloseInfo,
  CodecPreference,
  DisplayRect,
  ImageQualityPreset,
  KeyboardModeName,
  PeerSummary,
  PermissionName,
  ResolutionOption,
  ServerConfig,
  SessionEventMap,
  SessionOptions,
  SessionSettings,
  SessionState,
  SessionStats,
} from "./types.js";
export type { PeerOs } from "./keymap.js";
export { FileTransferSession } from "./files/session.js";
export { Download, IncomingFile } from "./files/download.js";
export { Upload } from "./files/upload.js";
export { FileTransferError } from "./files/types.js";
export type {
  ConflictAnswer,
  DownloadOptions,
  FileErrorCode,
  FileErrorEvent,
  FilePeerSummary,
  FileTransferEventMap,
  FileTransferOptions,
  RemoteDirectory,
  RemoteEntry,
  RemoteEntryType,
  RemoveOptions,
  TransferDirection,
  TransferFileInfo,
  TransferProgress,
  TransferResult,
  UploadConflict,
  UploadItem,
  UploadOptions,
} from "./files/types.js";
