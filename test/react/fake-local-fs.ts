// An in-memory File System Access folder tree (FileSystemDirectoryHandle /
// FileSystemFileHandle as far as the file manager's local pane uses them).

export const domError = (name: string) => new DOMException(name, name);

export class FakeFileHandle {
  readonly kind = "file" as const;
  constructor(
    readonly name: string,
    public data: Uint8Array = new Uint8Array(),
    public mtime = 1_700_000_000_000,
  ) {}
  async getFile(): Promise<File> {
    return new File([this.data as BlobPart], this.name, { lastModified: this.mtime });
  }
  async createWritable(): Promise<WritableStream<Uint8Array>> {
    const parts: Uint8Array[] = [];
    return new WritableStream<Uint8Array>({
      write: (c) => void parts.push(c),
      close: () => {
        this.data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let o = 0;
        for (const p of parts) {
          this.data.set(p, o);
          o += p.length;
        }
      },
    });
  }
  get text(): string {
    return new TextDecoder().decode(this.data);
  }
}

export class FakeDirHandle {
  readonly kind = "directory" as const;
  readonly children = new Map<string, FakeDirHandle | FakeFileHandle>();
  constructor(readonly name: string) {}
  async *values(): AsyncGenerator<FakeDirHandle | FakeFileHandle> {
    for (const c of this.children.values()) yield c;
  }
  async getDirectoryHandle(name: string, o: { create?: boolean } = {}): Promise<FakeDirHandle> {
    const c = this.children.get(name);
    if (c instanceof FakeDirHandle) return c;
    if (c) throw domError("TypeMismatchError");
    if (!o.create) throw domError("NotFoundError");
    return this.dir(name);
  }
  async getFileHandle(name: string, o: { create?: boolean } = {}): Promise<FakeFileHandle> {
    const c = this.children.get(name);
    if (c instanceof FakeFileHandle) return c;
    if (c) throw domError("TypeMismatchError");
    if (!o.create) throw domError("NotFoundError");
    return this.file(name, "");
  }
  /** Test helpers: add (or get) a child. */
  dir(name: string): FakeDirHandle {
    const d = this.children.get(name);
    if (d instanceof FakeDirHandle) return d;
    const n = new FakeDirHandle(name);
    this.children.set(name, n);
    return n;
  }
  file(name: string, text: string, mtime?: number): FakeFileHandle {
    const f = new FakeFileHandle(name, new TextEncoder().encode(text), mtime);
    this.children.set(name, f);
    return f;
  }
  at(path: string): FakeDirHandle | FakeFileHandle | undefined {
    let node: FakeDirHandle | FakeFileHandle | undefined = this;
    for (const part of path.split("/")) node = node instanceof FakeDirHandle ? node.children.get(part) : undefined;
    return node;
  }
}

export const asDir = (d: FakeDirHandle) => d as unknown as FileSystemDirectoryHandle;
