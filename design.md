# Wellington City Council — web design system

**Te Kaunihera o Pōneke · wellington.govt.nz**
Draft v0.1 · 8 August 2026

The core system: foundations, tokens, thirteen components, three page templates. **Rules** blocks are hard constraints; token names in `wcc-tokens.css` are the reference values behind every literal in this document.

The emergency-management extension — hazard severity, maps, the Community Emergency Hub layer, performance tiers, data channels — is documented separately in §9a–9f.

---

## 0. Provenance

Two things here are official; everything else is inference.

| Area | Source | Confidence |
|---|---|---|
| Yellow `#FFDD00`, Black `#000000` | wellington.govt.nz brand assets page | **Official** |
| Information architecture, section names, te reo pairings, copy voice | Read from the live site | High |
| Neutral ramp, link blue, status colours | Derived to satisfy WCAG 2.2 AA against the brand pair | Medium |
| Type scale, spacing, radii, shadows, motion | Inferred from the site's visual rhythm | Medium — *measure before shipping* |
| Typeface | **Substituted** — see §2 | **Low — needs confirmation** |

**Not obtained:** the live stylesheet, `wccbrand.co.nz` (access-restricted), the official logo pack. Three things to chase: the real webfont files, the full brand guidelines, and the logo pack.

### Rule — the marks are proprietary
The Council's graphics "may not be altered in any way, or combined with any other graphics, without written consent". The Council logo is therefore **never drawn, traced or approximated** — no hand-rolled koru, no reconstructed wordmark. The supplied file is placed as-is, or an empty slot of the correct dimensions holds its place. Minimum digital size **320px** wide, print **25mm**; clearspace is baked into the supplied files and is not cropped. Logo questions → `workflow@wcc.govt.nz`.

---

## 1. What this site is

A high-traffic, task-first council website. Residents arrive with an errand — pay rates, find the bin day, book a pool lane, submit on a consultation — and the design's whole job is to end that errand quickly.

Design consequences, in priority order:

1. **Findability beats beauty.** Search and a flat, plainly-named service taxonomy are the primary navigation. The homepage is a search box and a directory, not a brochure.
2. **Bicultural by default.** Te reo Māori sits alongside English throughout, not as decoration.
3. **Accessible by obligation.** Public sector: assume screen readers, 400% zoom, keyboard-only, low bandwidth, ten-year-old devices.
4. **Trustworthy over trendy.** No dark patterns, no growth-marketing tone, no ambiguity about what is a Council service and what is a third party.

**Rule:** any link leaving the Council domain carries a visible external-link affordance and an accessible "opens in new window" hint. Subdomains with their own identities (Fixit, Let's Talk, libraries, forms) are handed off to cleanly, not absorbed.

---

## 2. Typography

### Rules
- Body copy is **never** below `16px`. Article measure caps at `68ch`.
- Headings: `--leading-heading` (1.2) and `--tracking-tight` (-0.02em). Body: `--leading-body` (1.6), no tracking.
- Two weights in production text: **400** and **700**. 800 is reserved for the homepage display line. No faux bold, no italic for emphasis in UI chrome.
- `text-wrap: pretty` on headings and lead paragraphs; `text-wrap: balance` on short display lines only.
- **Macrons are non-negotiable.** Any font must render **Ā Ē Ī Ō Ū ā ē ī ō ū** correctly at every weight — test with *Pōneke*, *Tūpiki Ora*, *Te Tauihu*, *urupā*, *whakangahau*. A font that drops or clips a macron is disqualified.

### ⚠ Typeface substitution
The Council's actual webfont could not be read. This system ships **Public Sans** — open-licence, government-commissioned, full macron support — behind the `--wcc-font-sans` indirection. When the real font arrives, the swap is **one line in `wcc-tokens.css`**; font names never appear in component code.

Shipping no webfont at all is also a defensible choice for a council site, and is the required choice on emergency surfaces:

```
-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif
```

### Scale

| Token | Size | Use |
|---|---|---|
| `--text-display` | 40 → 64px fluid, 800 | Homepage "Kia ora" line only |
| `--text-h1` | 32 → 44px fluid, 700 | One per page |
| `--text-h2` | 24 → 32px fluid, 700 | Section headings |
| `--text-h3` | 22px, 700 | Card titles, accordion triggers |
| `--text-h4` | 18px, 700 | Sub-headings, footer column heads |
| `--text-lead` | 20px, 400 | Page intro paragraph |
| `--text-body-size` | 16px, 400 | Everything else |
| `--text-small` | 14px, 400/700 | Meta, dates, breadcrumbs, te reo eyebrow |

### The te reo eyebrow
The signature typographic device: a te reo Māori label directly above its English heading.

```html
<h3>
  <span class="eyebrow" lang="mi">Toi me Te Ahurea</span>
  Arts and culture
</h3>
```

- Eyebrow: `--text-small`, weight 700, `--tracking-eyebrow`, colour `--wcc-yellow-ink` — a dark ochre that carries the brand warmth *and* passes AA, which brand yellow would not.
- Always `lang="mi"` so screen readers switch pronunciation.
- English heading follows immediately. No separator glyph, no slash.
- The pair is **one heading element**, not two — two injects a phantom level into the document outline.

---

## 3. Colour

### The brand pair (official)

| | Hex | Pantone | CMYK | RGB | Resene |
|---|---|---|---|---|---|
| Yellow | `#FFDD00` | 109 C | 0 / 10 / 100 / 0 | 255 / 221 / 0 | Absolutely Yellow |
| Black | `#000000` | Black C | 0 / 0 / 0 / 100 | 0 / 0 / 0 | — |

### Rules — the yellow problem
`#FFDD00` is **1.2:1 against white** and **16.9:1 against black**. That single fact dictates most of the visual system.

- ✅ Yellow as a **background**, black text on top.
- ✅ Yellow as a **marker**: rules, underlines, focus halos, active indicators, flat blocks, the alert band.
- ✅ Yellow as a **large graphic shape** (≥24px, non-informational).
- ❌ Yellow text on white — at any size, ever.
- ❌ Yellow as a meaningful border or icon on a light background — use `--wcc-yellow-ink` `#5C4E00` (7.4:1).
- ❌ Yellow *and* a warning state in the same component. Yellow is the brand here, not a caution signal.

### Palette allocation
Discipline over range. **A page uses white plus at most one other background.** Yellow is a punctuation mark, not a wash.

- `--surface-page` (white) default · `--surface-alt` `#F7F7F5` bands alternate sections · `--surface-brand` (yellow) once or twice per page maximum · `--surface-inverse` (black) for the footer.
- **Never** a yellow gradient, a yellow-to-orange wash, or yellow at partial opacity. Flat, full-strength, or a tint token — nothing between.
- Links are `--wcc-link` `#0B4EA2`, visited `#4C2C92`. Functional blue, kept out of decorative use so its meaning stays unambiguous.

### Status colours
Because yellow is spoken for, statuses are a closed set: `--wcc-success` `#0B6B3A`, `--wcc-warning` `#8A5A00`, `--wcc-error` `#B3261E`, `--wcc-info` `#0B4EA2`, each with a `-surface` tint. **Every status pairs a colour with an icon and a text label** — colour is never the sole carrier.

---

## 4. Spacing, layout and grid

- 4px base, 8px rhythm: `--space-1` … `--space-9` (4, 8, 12, 16, 24, 32, 48, 64, 96).
- Container `--container-max: 1280px`, gutter `--container-pad: 24px`, article column `--measure-content: 720px`.
- Vertical section spacing: 64px desktop, 32px mobile. Adjacent same-colour sections collapse to one gap; different-colour sections keep both.
- **Rule:** sibling groups use `display: flex/grid` and `gap` — never inline elements spaced by margins or source whitespace.

**Breakpoints** `480 / 768 / 1024 / 1280`, mobile-first. Service grid 1 → 2 → 3 columns. Navigation collapses to a drawer below 1024.

**Touch** `--touch-min: 44px` on every interactive target, including homepage chips and mega-menu rows. Adjacent targets keep ≥8px separation.

---

## 5. Shape, depth, borders

Default posture is **square and flat**. Depth says "this floats above the page", not "this is a card".

- `--radius-md: 4px` on cards, buttons, inputs. `--radius-pill` **only** on popular-link chips and tags. Nothing else is rounded.
- Cards are defined by a `1px --border-hairline`, and on hover a black border plus `--shadow-2` — not by a resting shadow.
- `--shadow-3` is reserved for the mega-menu panel and modals.
- No inner shadows. No glass or blur — the sticky header is solid white with a hairline bottom border. Blur costs performance on the old devices this audience uses.
- The **4px yellow top rule** on cards and callouts is the system's one signature flourish. A page with eight yellow rules has none.

---

## 6. Interaction states

| State | Treatment |
|---|---|
| Hover (link) | underline appears / thickens to 2px; colour → `--wcc-link-hover` |
| Hover (card) | border → black, `--shadow-2`, title underlines. **No lift or translate.** |
| Hover (yellow button) | fill → `--wcc-yellow-600` |
| Hover (black button) | fill → `--wcc-grey-900` |
| Active / pressed | fill → `--wcc-yellow-700`; **no scale transform** |
| Focus-visible | 3px black outline, 2px offset, on a yellow halo — visible on white, grey, yellow and black alike |
| Disabled | `--wcc-grey-100` fill, `--wcc-grey-500` text, `cursor: not-allowed`, `aria-disabled` |
| Current page | 4px yellow left bar (side nav) or bottom bar (top nav) **plus** `aria-current="page"` |

**Motion** is sparse and short: `--dur-base: 200ms`, `--ease-standard`. Only colour, border, opacity and accordion height animate. No parallax, no scroll-jacking, no entrance animations, no bounce. `prefers-reduced-motion` zeroes the durations in the token file already.

---

## 7. Imagery and iconography

**Imagery** — documentary photography of Wellington and Wellingtonians: real people, real weather, natural light, cool coastal cast. No stock gloss, no filters, no grain overlay. 16:9 for news, 3:2 for cards. Meaningful `alt` on every image; `alt=""` on decorative ones. Text over a photo sits on a solid black band or a ≥60% scrim — never a bare drop shadow, never yellow text.

**No imagery ships with this system.** Templates use labelled placeholder blocks. Ask the Workflow Team for the photo library.

**Iconography — not resolved.** The site's own icon set could not be extracted; templates use **Lucide** as a flagged substitution. Icons are 20 or 24px, `currentColor`, `stroke-width: 2`. Decorative icons get `aria-hidden="true"`; icon-only buttons get an `aria-label`. One-off hand-drawn SVG icons and mixed icon families are outside the system. Emoji are never used in Council interface or content copy. Unicode arrows (→) are fine inside link text.

> On emergency surfaces, icon libraries are banned outright — see `design.md` §9e-0. Use words.

---

## 8. Content fundamentals — how the Council writes

Read from the live site. The voice is warm, plain and second-person.

- **"You" and "we".** Never "users", "customers", or "ratepayers" as a form of address.
- **Sentence case everywhere** — headings, buttons, nav, labels. Proper nouns and te reo names keep their capitals.
- **Verb-first calls to action:** "Report a problem", "Have your say", "Pay online".
- **A greeting where a hero headline would go:** *"Kia ora — what can we help you with?"* Bicultural and task-framing in one line. That is the tone target for the whole site.
- **NZ English:** organise, licence (noun) / license (verb), programme, centre, colour.
- **Te reo Māori** appears as section names, place names and the eyebrow pattern. Use macrons. Do not translate marketing copy into te reo as ornament, and **do not italicise te reo** — it is an official language, not a foreign word.
- **Plain language:** short sentences, one idea each. "Find out", not "ascertain". Explain jargon once ("LIM — Land Information Memorandum").
- **Descriptions are functional, not promotional.** List the tasks: *"Search cemetery records and find information about our cemeteries in Karori, Makara and Tawa."*
- **Never** exclamation marks in service copy, no emoji, no "Oops!", no "Sorry, something went wrong" without a next step.
- Dates `5 August 2026` · phone `04 499 4444` · money `$60 million`.

---

## 9. Component inventory

Built and browsable in `Wellington Design System.dc.html`. Thirteen components — the set the live site actually demonstrates. Nothing invented beyond that.

| Component | Notes |
|---|---|
| **AlertBanner** | Site-wide notice above the header. Yellow band, black text, `role="region"` + `aria-label`. Dismissible variant persists in `localStorage`. Max one at a time. |
| **Header** | Logo slot, search toggle, menu toggle, quick actions. Sticky, solid white, hairline bottom border. |
| **MegaMenu** | Two-level. Top level = the 15 service categories; panel lists children with a "Back" affordance on mobile. `--shadow-3`. Esc closes, focus returns to trigger. |
| **SearchHero** | The homepage's primary element. 56px field, black submit, label always present — never placeholder-only. |
| **ChipLink** | Popular-link pills. `--radius-pill`, hairline border, yellow fill on hover, 44px min height. |
| **ServiceCard** | Te reo eyebrow + English title + functional description. Whole card clickable via a stretched link on the title. Yellow top rule. |
| **Button** | `primary` (black fill), `secondary` (yellow fill, black text), `tertiary` (underlined text). Sizes `md` 44px / `lg` 52px. |
| **Breadcrumb** | The site's own idiom is a single "Back: <parent>" link — keep it, plus a full `nav > ol` trail for deeper pages. |
| **SideNav** | Section navigation. Current item: 4px yellow left bar + bold + `aria-current`. |
| **Accordion** | Native `<details>` / `<summary>`, chevron rotates, height animates. |
| **NewsCard** | 16:9 image, date, headline. Featured variant runs full width with the image beside the text. |
| **Callout** | Info / success / warning / error, plus a plain brand variant with the yellow top rule. Icon + label + body. |
| **Footer** | Black. Contact us / Visit us / Connect with us columns, then policy links, then the New Zealand Government crest slot. |

### Rules — components
- Every interactive component ships keyboard support and a visible focus state **before** it ships hover polish.
- Everything composes from these primitives — a button inside a card is the Button component, not a re-implementation.
- The inventory matches what the live site demonstrates. **A component with no counterpart on the real site is a liability.**

---

## 10. Page templates

1. **Homepage** — alert band → header → search hero → popular links → "Services and information" 15-card grid → news → newsletter → footer.
2. **Section landing** — breadcrumb → h1 + lead → child-page card grid → contextual callout → footer.
3. **Content page** — breadcrumb → h1 + lead → two columns (720px article + side nav) → accordion FAQs → related links → footer.

Not yet built, worth doing next: news article, transactional form page, search results, mobile navigation drawer.

---

## 11. Accessibility — WCAG 2.2 AA + NZ Government Web Standards

Both the NZ Government Web Accessibility Standard and the Web Usability Standard apply. Non-negotiables:

- **Contrast** ≥4.5:1 body text, ≥3:1 large text (≥24px, or ≥19px bold) and UI component boundaries. The yellow rules in §3 exist to satisfy this.
- **Focus visible** on every interactive element (2.4.7) and **not obscured** by the sticky header (2.4.11, new in 2.2) — add `scroll-margin-top: calc(header-height + 16px)` to anchor targets.
- **Target size** ≥24×24 CSS px minimum (2.5.8); this system requires 44px.
- **Skip to main content** as the first focusable element.
- **Landmarks:** one `<header>`, `<nav aria-label>`, `<main id="content">`, `<footer>`. One `<h1>` per page, no skipped levels.
- **`lang="en-NZ"`** on `<html>`, `lang="mi"` on every te reo string.
- **Reflow** to 320px with no horizontal scroll; usable at 400% zoom.
- **Forms:** visible persistent labels, errors in text beside the field *and* summarised at the top, `aria-describedby`, never colour-only.
- **Motion:** respect `prefers-reduced-motion`.

Test with keyboard only, then NVDA/VoiceOver, then at 400% zoom, then with CSS disabled. In that order.

---

## 12. Files

| File | What it is |
|---|---|
| `wcc-tokens.css` | The token layer — the single source for colour, type, spacing and motion values. Brand values marked official, everything else marked derived. |
| `Wellington Design System.dc.html` | Browsable specimen: foundations, every component with its states, the page templates. |
| `design.md` | The full document — this core system plus the emergency-management extension (§9a maps, §9b hazard severity, §9d the Hub layer, §9e-0 performance tiers, §9f data channels). |
| `emergency-dashboard.html` | National hazard dashboard. Sample data. |
| `Hub Companion Demo.dc.html` | The Community Emergency Hub console — eleven screens, five languages, the Kea assistant. |

### Open questions
1. The real webfont name and files.
2. `wccbrand.co.nz` — photography direction, secondary palette, te reo typographic rules.
3. The official logo pack and the site's own icon set.
4. Measured values from the live stylesheet, to replace the inferred type, spacing and elevation scales.
