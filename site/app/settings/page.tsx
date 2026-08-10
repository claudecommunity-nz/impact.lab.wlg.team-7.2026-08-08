import SettingsPanel from "../SettingsPanel";
import { SiteFooter, SiteHeader } from "../SiteChrome";

export const metadata = {
  title: "Data sources · Murmur",
  description:
    "Source status, last sync, import and export in four formats, and the API, MCP and A2A integrations behind the Murmur operating picture.",
};

export default function SettingsRoute() {
  return (
    <div className="watch-shell">
      <a className="skip-link" href="#content">
        Skip to main content
      </a>
      <SiteHeader />

      <main id="content">
        <section className="brand-band">
          <div className="settings-intro">
            <p className="eyebrow">Settings · outside the operating picture</p>
            <h1>Data sources and integrations</h1>
            <p className="intro-copy">
              Sources, status, sync and export. Everything configured here stays
              in this browser.
            </p>
          </div>
        </section>

        <SettingsPanel />
      </main>

      <SiteFooter />
    </div>
  );
}
