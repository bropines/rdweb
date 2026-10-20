// Links to the official RustDesk client, which can do what a browser cannot
// (direct P2P connections, being controlled, more features).
import { ExternalLink } from "lucide-react";

import { useAppI18n } from "./i18n";

const LINKS = [
  { id: "github", href: "https://github.com/rustdesk/rustdesk/releases/latest" },
  { id: "play", href: "https://play.google.com/store/apps/details?id=com.carriez.flutter_hbb" },
  { id: "fdroid", href: "https://f-droid.org/packages/com.carriez.flutter_hbb/" },
  { id: "appstore", href: "https://apps.apple.com/app/rustdesk-remote-desktop/id1581225015" },
] as const;

export function OfficialApps({ className }: { className?: string }) {
  const { t } = useAppI18n();
  return (
    <section className={className} aria-labelledby="official-apps-title">
      <h3 id="official-apps-title" className="font-medium">
        {t("official.title")}
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">{t("official.text")}</p>
      <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
        {LINKS.map((l) => (
          <li key={l.id}>
            <a
              href={l.href}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0">{t(`official.${l.id}`)}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
