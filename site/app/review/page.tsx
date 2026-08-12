import ReviewQueue from "./ReviewQueue";
import { SiteFooter, SiteHeader } from "../SiteChrome";
import health from "../../public/cop/v1/movement-health.json";

export const metadata = {
  title: "Signal review · Murmur",
  description:
    "Browser-local triage for published movement signals: status, outcome and notes. Not a Council record.",
};

export default function ReviewRoute() {
  return (
    <div className="watch-shell">
      <a className="skip-link" href="#content">
        Skip to main content
      </a>
      <SiteHeader />

      <main id="content">
        <section className="brand-band">
          <div className="settings-intro">
            <p className="eyebrow">Signal review · browser-local, not a Council record</p>
            <h1>Signal review</h1>
            <p className="intro-copy">
              {`${health.candidate_count} published signals · status, outcome and notes stay in this browser.`}
            </p>
          </div>
        </section>

        <div className="investigation-shell">
          <ReviewQueue />
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
