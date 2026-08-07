# Murmur — 2 minute pitch script

> Measuring the city's heartbeat and detecting irregularities.

Timings are cumulative. Total runtime ~2:00 at a natural speaking pace.

---

## [0:00–0:15] Hook

> "Right now, when something goes wrong in Wellington — a slip above the Terrace, a burst main, a crash closing a tunnel — the Council usually finds out because somebody picks up the phone. One report at a time.
>
> But the city is already telling us. We just haven't been listening."

**Visual:** dark, near-empty map of Wellington. Phone-call icons appear one at a time with timestamps (3:42pm, 3:51pm, 4:06pm). Fade to blank map on the last line.

---

## [0:15–0:35] The insight

> "Every city has a heartbeat. Foot traffic on Cuba Street, vehicles on the quays — it follows a rhythm. Tuesday morning looks like Tuesday morning.
>
> And the exceptions have a rhythm too: a cruise ship day, Ed Sheeran at the Caketin, school holidays. These aren't anomaliess, they're just a different kind of normal."

**Visual:** ECG-style trace of a week of foot traffic, with the expected baseline ghosted underneath and matching. Then a hard spike labelled *Cruise: [ship], 0700* — the spike turns amber, not red, because it was predicted.

---

## [0:35–1:15] What we built

> "So we built **Murmur** — measuring the city's heartbeat and detecting irregularities.
>
> First, a **baseline**. We learn the expected movement at each location, by hour and by day of week.
>
> Second, a **known-exceptions calendar** — cruise arrivals, major events, holidays — so a packed waterfront on a cruise day doesn't cry wolf.
>
> Third, **detection**. When live movement diverges from expected beyond threshold, we flag it and immediately try to explain it: cross-checking weather warnings, road closures, and public reports.
>
> If we can explain it, it's context. If we can't — that's the signal worth waking someone up for."

**Visual:** diagram assembling one layer per sentence — 7×24 baseline heatmap, then a calendar strip with event icons dropping on, then a live value arriving and forking to *Explained* / *Unexplained*.

---

## [1:15–1:35] Demo

> "Here's the map. Green is breathing normally. Amber is diverging. Red is unexplained.
>
> *[click]* This is **[date / incident]** — watch the change propagate outward from the incident, ahead of the first report coming in."

**Visual:** screen recording of the prototype. Green nodes pulsing → one goes amber → neighbours follow as movement reroutes → origin flips red with a confidence callout. Timestamp ribbon showing *first public report: +[N] min*.

---

## [1:35–1:50] Notifications

> "From there, tiered alerts. Duty controllers get the unexplained anomalies early — so they can verify, dispatch, or stand down before the calls start coming in.
>
> And where confidence is high, a public advisory can be drafted ready for a human to dispatch."

**Visual:** phone mockup receiving the internal alert (location, magnitude, *no matching closure or warning*, confidence). Beside it, a greyed second tier labelled *public advisory — human approval required*.

---

## [1:50–2:00] Caveat and close

> "One thing we won't bury: this data has real limitations — coverage gaps, sensor outages. So every alert carries its confidence and its caveats on the face of it.
>
> This isn't a source of truth. It's one more early sign that something deserves a human's attention."

**Visual:** zoomed alert card with limitations rendered on the card itself — coverage gap warning, sensors offline count, confidence band. Cut to Murmur wordmark with the pulse motif looping small.

---

## Delivery notes

- **Don't cut the caveat.** The brief explicitly requires Pōneke Travel Insights' documented data limitations to stay visible in emergency use. Judges will be listening for it.
- **If running long, trim the demo narration** — not the three layers. The layers are what separate Murmur from a naive threshold alarm.
- **Placeholders to fill before recording:** `[date / incident]`, the cruise ship name, and the `+[N] min` lead time. Pick an incident with a documented timeline so the lead-time gap holds up under questioning.
- **The 1:35–1:50 beat was the weakest in draft.** The version above closes it out; adjust to match whatever the notification tiers actually do in the build.
