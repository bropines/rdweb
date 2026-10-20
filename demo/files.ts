// "Files" panel of the demo: browse the remote file system, download files
// and folders (into a picked folder where the File System Access API exists,
// otherwise file by file as Blobs), upload files or a folder, mkdir, rename,
// delete.

import { FileTransferSession, type RemoteEntry, type ServerConfig, type TransferProgress } from "../src/index.js";

type DirPicker = (opts?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...kids);
  return e;
}

function size(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${u[i]}`;
}

async function fileHandle(root: FileSystemDirectoryHandle, relativePath: string): Promise<FileSystemFileHandle> {
  const parts = relativePath.split("/");
  let dir = root;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
  return dir.getFileHandle(parts.at(-1)!, { create: true });
}

function saveBlob(blob: Blob, name: string): void {
  const a = el("a", { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export async function startFiles(root: HTMLElement, server: ServerConfig, peerId: string): Promise<void> {
  const ft = new FileTransferSession({ peerId, server, myName: "rdweb demo" });
  (window as unknown as { ft: FileTransferSession }).ft = ft;
  root.classList.remove("hidden");

  const status = el("span", { id: "fstatus" });
  const pathInput = el("input", { placeholder: "remote path", className: "fpath" });
  const hidden = el("input", { type: "checkbox" });
  const table = el("tbody");
  const transfers = el("div", { className: "ftransfers" });
  const pickFiles = el("input", { type: "file", multiple: true, className: "hidden" });
  const pickDir = el("input", { type: "file", className: "hidden" });
  pickDir.webkitdirectory = true;
  let cwd = "";

  const button = (label: string, fn: () => unknown, title = "") => el("button", { textContent: label, title, onclick: () => void fn() });
  const fail = (e: unknown) => (status.textContent = `error: ${(e as Error).message}`);

  async function open(path: string): Promise<void> {
    try {
      const dir = await ft.listDir(path, { showHidden: hidden.checked });
      cwd = dir.path;
      pathInput.value = cwd;
      render(dir.entries);
      status.textContent = `${dir.entries.length} entries`;
    } catch (e) {
      fail(e);
    }
  }

  function render(entries: RemoteEntry[]): void {
    const isDir = (e: RemoteEntry) => e.type === "dir" || e.type === "dirLink" || e.type === "drive";
    const sorted = [...entries].sort((a, b) => Number(isDir(b)) - Number(isDir(a)) || a.name.localeCompare(b.name));
    table.replaceChildren(
      ...sorted.map((e) => {
        const full = ft.joinPath(cwd, e.name);
        const name = isDir(e)
          ? el("a", { href: "#", textContent: `${e.name}${e.type === "drive" ? "" : "/"}`, onclick: (ev: Event) => (ev.preventDefault(), void open(full)) })
          : el("span", { textContent: e.name });
        const actions = el("td");
        if (e.type !== "drive") {
          actions.append(
            button("⬇", () => download(full, isDir(e)), "Download"),
            button("✎", () => rename(full, e.name), "Rename"),
            button("✕", () => remove(full, isDir(e)), "Delete"),
          );
        }
        return el(
          "tr",
          { className: e.hidden ? "fhidden" : "" },
          el("td", {}, name),
          el("td", { textContent: isDir(e) ? "" : size(e.size) }),
          el("td", { textContent: e.modified ? new Date(e.modified).toLocaleString() : "" }),
          actions,
        );
      }),
    );
  }

  function progressLine(label: string): (p: TransferProgress) => void {
    const line = el("div", { textContent: label });
    transfers.prepend(line);
    return (p) => {
      const pct = p.totalBytes ? Math.floor((p.bytes / p.totalBytes) * 100) : 0;
      line.textContent = `${label}: ${pct}% ${size(p.bytes)}/${size(p.totalBytes)} files ${p.filesDone}/${p.files}${p.skipped ? ` skipped ${p.skipped}` : ""}${p.file ? ` — ${p.file.relativePath}` : ""}`;
    };
  }

  async function download(path: string, dir: boolean): Promise<void> {
    const onProgress = progressLine(`⬇ ${path}`);
    try {
      const picker = (window as unknown as { showDirectoryPicker?: DirPicker }).showDirectoryPicker;
      if (picker) {
        const target = await picker({ mode: "readwrite" });
        await ft.download(path, { onProgress, showHidden: hidden.checked }).saveTo(async (f) => (await fileHandle(target, f.relativePath)).createWritable());
      } else if (!dir) {
        const { file, blob } = await ft.downloadBlob(path, { onProgress, maxBytes: 512 << 20 });
        saveBlob(blob, file.relativePath);
      } else {
        // no folder access: hand out the files one by one
        for await (const f of ft.download(path, { onProgress, showHidden: hidden.checked })) {
          saveBlob(await f.blob(512 << 20), f.relativePath.replace(/\//g, "_"));
        }
      }
    } catch (e) {
      fail(e);
    }
  }

  async function upload(files: FileList | null): Promise<void> {
    if (!files?.length) return;
    const onProgress = progressLine(`⬆ ${files.length} file(s) → ${cwd}`);
    try {
      await ft.upload(files, cwd, { onProgress }).done;
      await open(cwd);
    } catch (e) {
      fail(e);
    }
  }

  async function rename(path: string, name: string): Promise<void> {
    const next = prompt("New name", name);
    if (!next || next === name) return;
    await ft.rename(path, next).then(() => open(cwd), fail);
  }

  async function remove(path: string, dir: boolean): Promise<void> {
    if (!confirm(`Delete ${path}${dir ? " and everything in it" : ""}?`)) return;
    await ft.remove(path, { dir, recursive: dir }).then(() => open(cwd), fail);
  }

  pickFiles.onchange = () => void upload(pickFiles.files).finally(() => (pickFiles.value = ""));
  pickDir.onchange = () => void upload(pickDir.files).finally(() => (pickDir.value = ""));
  pathInput.onkeydown = (ev) => {
    if (ev.key === "Enter") void open(pathInput.value);
  };
  hidden.onchange = () => void open(cwd);

  root.replaceChildren(
    el(
      "div",
      { className: "fbar" },
      button("↑", () => open(ft.parentPath(cwd)), "Parent folder"),
      button("⌂", () => open(""), "Home"),
      pathInput,
      button("Go", () => open(pathInput.value)),
      el("label", {}, hidden, " hidden"),
      button("New folder", async () => {
        const name = prompt("Folder name");
        if (name) await ft.mkdir(ft.joinPath(cwd, name)).then(() => open(cwd), fail);
      }),
      button("Upload files", () => pickFiles.click()),
      button("Upload folder", () => pickDir.click()),
      button("Disconnect", () => ft.close()),
      pickFiles,
      pickDir,
      status,
    ),
    el("table", { className: "ftable" }, el("thead", {}, el("tr", {}, ...["Name", "Size", "Modified", ""].map((h) => el("th", { textContent: h })))), table),
    transfers,
  );

  ft.on("state", ({ state }) => (status.textContent = state));
  ft.on("password", ({ wrong }) => {
    const pwd = prompt(wrong ? "Wrong password, try again" : "Password");
    if (pwd) void ft.login(pwd);
  });
  ft.on("twoFactor", () => {
    const code = prompt("2FA code");
    if (code) ft.submitTwoFactor(code);
  });
  ft.on("waitingForApproval", () => (status.textContent = "waiting for the remote user to accept…"));
  ft.on("conflict", ({ conflict, answer }) => {
    const c = conflict;
    const msg = `${c.file.relativePath} exists on the remote side (${size(c.remote.size)}, ${new Date(c.remote.modified).toLocaleString()})${c.identical ? ", identical" : ""}.\nOK = overwrite, Cancel = skip`;
    answer(confirm(msg) ? "overwrite" : "skip");
  });
  ft.on("error", (e) => console.warn("file transfer error", e));
  ft.on("close", (c) => (status.textContent = `closed: ${c.reason}`));
  try {
    await ft.connect();
    cwd = ft.homeDir;
    await open(cwd);
  } catch (e) {
    fail(e);
  }
}
