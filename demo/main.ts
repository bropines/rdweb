import { Session, Viewer, type SessionSettings } from "../src/index.js";
import { startFiles } from "./files.js";

const form = document.getElementById("connect") as HTMLFormElement;
const bar = document.getElementById("bar")!;
const view = document.getElementById("view")!;
const files = document.getElementById("files")!;

for (const k of ["idUrl", "relayUrl", "key", "peer", "mode"]) {
  const el = form.elements.namedItem(k) as HTMLInputElement;
  if (k === "mode") {
    el.value = localStorage.getItem(`rdweb-demo-${k}`) || "desktop";
    continue;
  }
  el.value = localStorage.getItem(`rdweb-demo-${k}`) ?? "";
}

function select<T extends string>(label: string, options: [T, string][], value: T, onChange: (v: T) => void): HTMLSelectElement {
  const s = document.createElement("select");
  s.title = label;
  for (const [v, t] of options) s.add(new Option(`${label}: ${t}`, v, false, v === value));
  s.onchange = () => onChange(s.value as T);
  bar.appendChild(s);
  return s;
}
function button(label: string, fn: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.onclick = fn;
  bar.appendChild(b);
  return b;
}

form.onsubmit = async (e) => {
  e.preventDefault();
  const v = (k: string) => (form.elements.namedItem(k) as HTMLInputElement).value.trim();
  for (const k of ["idUrl", "relayUrl", "key", "peer", "mode"]) localStorage.setItem(`rdweb-demo-${k}`, v(k));
  const relay = v("relayUrl");
  const server = { rendezvousUrl: v("idUrl"), relayUrl: relay ? () => relay : undefined, key: v("key") };
  if (v("mode") === "files") {
    form.classList.add("hidden");
    await startFiles(files, server, v("peer"));
    return;
  }
  const session = new Session({
    peerId: v("peer"),
    server,
    myName: "rdweb demo",
  });
  (window as unknown as { session: Session }).session = session;
  form.classList.add("hidden");
  bar.classList.remove("hidden");
  view.classList.remove("hidden");
  const viewer = new Viewer(view, session);
  (window as unknown as { viewer: Viewer }).viewer = viewer;
  const status = document.createElement("span");
  status.id = "status";

  const set = (p: Partial<SessionSettings>) => session.updateSettings(p);
  const s = session.settings;
  select("Quality", [["best", "Good"], ["balanced", "Balanced"], ["low", "Fast"], ["custom", "Custom"]], s.imageQuality, (q) => set({ imageQuality: q }));
  select("FPS", [["30", "30"], ["60", "60"], ["15", "15"]], "30", (f) => set({ imageQuality: "custom", customFps: Number(f) }));
  const codecSel = select("Codec", [["auto", "Auto"]], "auto", (c) => set({ codec: c as SessionSettings["codec"] }));
  select("View", [["fit", "Fit"], ["original", "1:1"], ["stretch", "Stretch"]], "fit", (m) => viewer.setScaleMode(m));
  select("Input", [["mouse", "Mouse"], ["trackpad", "Trackpad"], ["touch", "Touch"]], viewer.getInputMode(), (m) => viewer.setInputMode(m));
  select("Keys", [["map", "Map"], ["translate", "Translate"], ["legacy", "Legacy"]], s.keyboardMode, (k) => set({ keyboardMode: k }));
  const resSel = select("Res", [["", "—"]], "", (r) => {
    const [w, h] = r.split("x").map(Number);
    session.changeResolution(w ?? 0, h ?? 0);
  });
  const dispSel = select("Display", [["0", "1"]], "0", (d) => session.switchDisplay(Number(d)));
  const toggle = (label: string, key: keyof SessionSettings) =>
    button(`${label}`, () => {
      set({ [key]: !session.settings[key] } as Partial<SessionSettings>);
      status.textContent = `${label}: ${session.settings[key] ? "on" : "off"}`;
    });
  toggle("Remote cursor", "showRemoteCursor");
  toggle("Mute", "disableAudio");
  toggle("View only", "viewOnly");
  toggle("True color", "trueColor");
  button("Ctrl+Alt+Del", () => session.ctrlAltDel());
  button("Lock", () => session.lockScreen());
  button("Refresh", () => session.refreshVideo());
  button("Keyboard", () => viewer.showKeyboard());
  button("Fullscreen", () => void viewer.enterFullscreen(document.getElementById("app")!));
  button("Disconnect", () => session.close());
  bar.appendChild(status);

  session.on("state", ({ state }) => (status.textContent = state));
  session.on("password", ({ wrong }) => {
    const pwd = prompt(wrong ? "Wrong password, try again" : "Password");
    if (pwd) void session.login(pwd);
  });
  session.on("twoFactor", () => {
    const code = prompt("2FA code");
    if (code) session.submitTwoFactor(code);
  });
  session.on("waitingForApproval", () => (status.textContent = "waiting for the remote user to accept…"));
  session.on("peer", ({ peer }) => fillPeer(peer));
  session.on("connected", ({ peer }) => {
    fillPeer(peer);
    viewer.focus();
  });
  function fillPeer(peer: NonNullable<Session["peer"]>) {
    codecSel.length = 1;
    for (const c of peer.codecs) codecSel.add(new Option(`Codec: ${c.toUpperCase()}`, c, false, session.settings.codec === c));
    resSel.length = 1;
    for (const r of peer.resolutions) resSel.add(new Option(`Res: ${r.width}x${r.height}`, `${r.width}x${r.height}`));
    dispSel.length = 0;
    for (const d of peer.displays) dispSel.add(new Option(`Display: ${d.index + 1}`, String(d.index), false, d.index === peer.currentDisplay));
  }
  session.on("stats", (st) => {
    status.textContent = `${st.codec ?? "?"}${st.chroma444 ? " 444" : ""} ${st.width}x${st.height} ${st.fps}fps ${st.kbps}kbps rtt ${st.delayMs}ms drop ${st.dropped}`;
  });
  session.on("message", (m) => console.info("message", m));
  session.on("close", (c) => {
    status.textContent = `closed: ${c.reason}`;
  });
  try {
    await session.connect();
  } catch (err) {
    status.textContent = `failed: ${(err as Error).message}`;
  }
};
