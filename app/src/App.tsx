import { FolderOpen, Info, Languages, Monitor, Moon, Pencil, Plus, Server, Sun, SquareTerminal, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { clearStoredData, RemoteDesktop, Toaster, type Lang } from "rdweb/react";
import { Button } from "@ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@ui/dropdown-menu";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";

import { BUILD, COMMIT_URL, SHORT_COMMIT } from "./build";
import { AppI18n, appTranslator, initialLang, storeLang, useAppI18n } from "./i18n";
import { ServerEditor } from "./ServerEditor";
import {
  clearAppData,
  endpoints,
  loadRecentDevices,
  loadServers,
  pushRecentDevice,
  saveServers,
  shortKey,
  toServerConfig,
  type RecentDevice,
  type ServerEntry,
} from "./servers";
import { useTheme, type ThemeChoice } from "./theme";

const SOURCE_URL = "https://github.com/bropines/rdweb";
const LAST_SERVER_KEY = "rdweb.app.lastServer";

type Mode = "desktop" | "files" | "terminal";

interface Active {
  server: ServerEntry;
  peerId: string;
  mode: Mode;
}

function readLastServer(): string | null {
  try {
    return localStorage.getItem(LAST_SERVER_KEY);
  } catch {
    return null;
  }
}

export function App() {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const { theme, setTheme, dark } = useTheme();
  const [servers, setServersState] = useState<ServerEntry[]>(loadServers);
  const [recent, setRecent] = useState<RecentDevice[]>(loadRecentDevices);
  const [active, setActive] = useState<Active | null>(null);
  const [lastPeer, setLastPeer] = useState("");
  const i18n = useMemo(() => ({ t: appTranslator(lang), lang }), [lang]);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = (l: Lang) => {
    setLangState(l);
    storeLang(l);
  };
  const setServers = (list: ServerEntry[]) => {
    setServersState(list);
    saveServers(list);
  };

  // The browser's back button leaves a session.
  useEffect(() => {
    const onPop = () => setActive(null);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const start = (server: ServerEntry, peerId: string, mode: Mode = "desktop") => {
    try {
      localStorage.setItem(LAST_SERVER_KEY, server.id);
    } catch {
      /* storage unavailable */
    }
    window.history.pushState({ rdwebSession: true }, "");
    setLastPeer(peerId);
    setActive({ server, peerId, mode });
  };
  const leave = useCallback(() => {
    if ((window.history.state as { rdwebSession?: boolean } | null)?.rdwebSession) window.history.back();
    else setActive(null);
  }, []);

  return (
    <AppI18n.Provider value={i18n}>
      <Toaster theme={dark ? "dark" : "light"} position="top-center" richColors closeButton />
      {active ? (
        <Session active={active} lang={lang} onLeave={leave} onRecent={setRecent} />
      ) : (
        <Home
          servers={servers}
          setServers={setServers}
          recent={recent}
          setRecent={setRecent}
          onConnect={start}
          initialPeer={lastPeer}
          lang={lang}
          setLang={setLang}
          theme={theme}
          setTheme={setTheme}
        />
      )}
    </AppI18n.Provider>
  );
}

function Session({ active, lang, onLeave, onRecent }: { active: Active; lang: Lang; onLeave: () => void; onRecent: (r: RecentDevice[]) => void }) {
  const { t } = useAppI18n();
  const server = useMemo(() => toServerConfig(active.server), [active.server]);
  const messages = useMemo(() => ({ toolbar: { back: t("session.back") } }), [t]);
  return (
    <RemoteDesktop
      peerId={active.peerId}
      server={server}
      lang={lang}
      messages={messages}
      mode={active.mode}
      onLeave={onLeave}
      onConnected={(peer) => onRecent(pushRecentDevice(active.server.id, active.peerId, peer.hostname || undefined))}
    />
  );
}

interface HomeProps {
  servers: ServerEntry[];
  setServers: (s: ServerEntry[]) => void;
  recent: RecentDevice[];
  setRecent: (r: RecentDevice[]) => void;
  onConnect: (server: ServerEntry, peerId: string, mode?: Mode) => void;
  initialPeer: string;
  lang: Lang;
  setLang: (l: Lang) => void;
  theme: ThemeChoice;
  setTheme: (t: ThemeChoice) => void;
}

function Home(p: HomeProps) {
  const { t } = useAppI18n();
  const [editing, setEditing] = useState<Partial<ServerEntry> | null>(null);
  const [deleting, setDeleting] = useState<ServerEntry | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [serverId, setServerId] = useState<string>(() => {
    const last = readLastServer();
    return p.servers.find((s) => s.id === last)?.id ?? p.servers[0]?.id ?? "";
  });
  const [peerId, setPeerId] = useState(p.initialPeer);
  const selected = p.servers.find((s) => s.id === serverId) ?? p.servers[0];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const id = peerId.replace(/\s+/g, "");
    if (selected && id) p.onConnect(selected, id);
  };

  const ThemeIcon = p.theme === "dark" ? Moon : p.theme === "light" ? Sun : Monitor;

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center gap-2 px-4 py-3">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="h-7 w-7" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold leading-tight">
              rdweb{" "}
              <span className="font-mono text-xs font-normal text-muted-foreground" title={SHORT_COMMIT ? `${SHORT_COMMIT} · ${BUILD.date}` : BUILD.date}>
                v{BUILD.version}
              </span>
            </div>
            <div className="truncate text-xs text-muted-foreground">{t("tagline")}</div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" aria-label={t("language")} title={t("language")}>
                <Languages className="h-4 w-4" />
                <span className="uppercase">{p.lang}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup value={p.lang} onValueChange={(v) => p.setLang(v as Lang)}>
                <DropdownMenuRadioItem value="en">English</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="ru">Русский</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={t("theme.label")} title={t("theme.label")}>
                <ThemeIcon className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup value={p.theme} onValueChange={(v) => p.setTheme(v as ThemeChoice)}>
                <DropdownMenuRadioItem value="light">{t("theme.light")}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark">{t("theme.dark")}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="system">{t("theme.system")}</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="icon" aria-label={t("about.title")} title={t("about.title")} onClick={() => setAboutOpen(true)}>
            <Info className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-5xl flex-1 items-start gap-4 px-4 py-6 grid-cols-1 md:grid-cols-2">
        <section className="space-y-4 rounded-lg border bg-card p-5 text-card-foreground shadow-sm">
          <h1 className="text-lg font-semibold">{t("connect.title")}</h1>
          {p.servers.length === 0 ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{t("connect.noServers")}</p>
              <Button onClick={() => setEditing({})}>
                <Plus className="h-4 w-4" />
                {t("servers.add")}
              </Button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="cn-server">{t("connect.server")}</Label>
                <Select value={selected?.id ?? ""} onValueChange={setServerId}>
                  <SelectTrigger id="cn-server" aria-label={t("connect.server")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {p.servers.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cn-peer">{t("connect.device")}</Label>
                <Input
                  id="cn-peer"
                  value={peerId}
                  onChange={(e) => setPeerId(e.target.value)}
                  inputMode="numeric"
                  autoComplete="off"
                  autoFocus
                  placeholder="123 456 789"
                />
              </div>
              <Button type="submit" className="w-full" disabled={!peerId.trim() || !selected}>
                {t("connect.button")}
              </Button>
              <div className="grid grid-cols-2 gap-2">
                {(["files", "terminal"] as const).map((m) => (
                  <Button
                    key={m}
                    type="button"
                    variant="outline"
                    disabled={!peerId.trim() || !selected}
                    onClick={() => {
                      const id = peerId.replace(/\s+/g, "");
                      if (selected && id) p.onConnect(selected, id, m);
                    }}
                  >
                    {m === "files" ? <FolderOpen className="h-4 w-4" /> : <SquareTerminal className="h-4 w-4" />}
                    {t(`connect.${m}`)}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">{t("connect.hint")}</p>
            </form>
          )}
          {p.recent.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs text-muted-foreground">{t("connect.recent")}</div>
              <ul className="flex flex-wrap gap-1.5">
                {p.recent.map((r) => {
                  const server = p.servers.find((s) => s.id === r.serverId);
                  return (
                    <li key={`${r.serverId}/${r.id}`} className="max-w-full">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-auto max-w-full flex-col items-start gap-0 py-1"
                        disabled={!server}
                        title={server ? undefined : t("connect.unknownServer")}
                        onClick={() => server && p.onConnect(server, r.id)}
                      >
                        <span className="max-w-full truncate">{r.name ? `${r.name} · ${r.id}` : r.id}</span>
                        <span className="max-w-full truncate text-[10px] font-normal text-muted-foreground">{server?.name ?? "—"}</span>
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>

        <section className="space-y-4 rounded-lg border bg-card p-5 text-card-foreground shadow-sm">
          <div className="flex items-center gap-2">
            <h2 className="flex-1 text-lg font-semibold">{t("servers.title")}</h2>
            <Button size="sm" variant="outline" onClick={() => setEditing({})}>
              <Plus className="h-4 w-4" />
              {t("servers.add")}
            </Button>
          </div>
          {p.servers.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("servers.empty")}</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {p.servers.map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-3 py-2.5">
                  <Server className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{s.name}</div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground" title={endpoints(s.address, s.relay).rendezvousUrl}>
                      {endpoints(s.address, s.relay).rendezvousUrl}
                    </div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">
                      {t("servers.key")}: {shortKey(s.key)}
                    </div>
                  </div>
                  <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t("servers.edit")} title={t("servers.edit")} onClick={() => setEditing(s)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" aria-label={t("servers.delete")} title={t("servers.delete")} onClick={() => setDeleting(s)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">{t("editor.requirements")}</p>
        </section>
      </main>

      <footer className="px-4 pb-6 text-center text-xs text-muted-foreground">
        <a className="underline-offset-4 hover:underline" href={SOURCE_URL} target="_blank" rel="noreferrer noopener">
          {t("about.source")}
        </a>{" "}
        · MIT · <BuildInfo />
      </footer>

      <ServerEditor
        editing={editing}
        onClose={() => setEditing(null)}
        onSave={(s) => {
          const exists = p.servers.some((x) => x.id === s.id);
          p.setServers(exists ? p.servers.map((x) => (x.id === s.id ? s : x)) : [...p.servers, s]);
          setServerId(s.id);
          setEditing(null);
        }}
      />

      <Dialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md" closeLabel={t("about.close")}>
          <DialogHeader>
            <DialogTitle>{t("servers.deleteTitle", { name: deleting?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("servers.deleteDesc")}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeleting(null)}>
              {t("editor.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleting) p.setServers(p.servers.filter((x) => x.id !== deleting.id));
                setDeleting(null);
              }}
            >
              {t("servers.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <About
        open={aboutOpen}
        onOpenChange={setAboutOpen}
        onClear={() => {
          clearStoredData();
          clearAppData();
          p.setServers([]);
          p.setRecent([]);
          setAboutOpen(false);
          toast.success(t("about.cleared"));
        }}
      />
    </div>
  );
}

function About({ open, onOpenChange, onClear }: { open: boolean; onOpenChange: (o: boolean) => void; onClear: () => void }) {
  const { t } = useAppI18n();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!open) setArmed(false);
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] max-w-[calc(100vw-1rem)] overflow-y-auto sm:max-w-lg" closeLabel={t("about.close")}>
        <DialogHeader>
          <DialogTitle>{t("about.title")}</DialogTitle>
          <DialogDescription>{t("about.intro")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          <h3 className="font-medium">{t("about.privacyTitle")}</h3>
          <ul className="list-disc space-y-1.5 pl-5 text-muted-foreground">
            <li>{t("about.p1")}</li>
            <li>{t("about.p2")}</li>
            <li>{t("about.p3")}</li>
          </ul>
          <h3 className="pt-2 font-medium">{t("editor.requirementsTitle")}</h3>
          <p className="text-muted-foreground">{t("editor.requirements")}</p>
          <p className="pt-2">
            <a className="text-primary underline-offset-4 hover:underline" href={SOURCE_URL} target="_blank" rel="noreferrer noopener">
              {t("about.source")}: github.com/bropines/rdweb
            </a>
          </p>
          <p className="text-xs text-muted-foreground">
            {t("about.build")}: <BuildInfo />
          </p>
        </div>
        <DialogFooter className="gap-2">
          <Button variant={armed ? "destructive" : "outline"} className={armed ? "h-auto whitespace-normal" : "text-destructive"} onClick={() => (armed ? onClear() : setArmed(true))}>
            <Trash2 className="h-4 w-4" />
            {armed ? t("about.clearConfirm") : t("about.clear")}
          </Button>
          <Button onClick={() => onOpenChange(false)}>{t("about.close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "rdweb 0.4.1 · 0021d01 · 2026-10-20": which build this page is. */
function BuildInfo() {
  return (
    <span className="whitespace-nowrap font-mono">
      v{BUILD.version}
      {SHORT_COMMIT && (
        <>
          {" · "}
          <a className="underline-offset-4 hover:underline" href={COMMIT_URL} target="_blank" rel="noreferrer noopener">
            {SHORT_COMMIT}
          </a>
        </>
      )}
      {" · "}
      {BUILD.date}
    </span>
  );
}
