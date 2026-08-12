/*
 * Signal review: a browser-local triage queue over published movement signals.
 * Same store pattern as data-sources (useSyncExternalStore, cached snapshot).
 * A review status is an operator's working note in this browser — never a
 * Council record, an incident or a warning. Items are stored only once
 * touched; an untouched signal is implicitly "new".
 */

export const REVIEW_KEY = "murmur.review.v1";

export type ReviewStatus = "investigating" | "closed";

export type ReviewOutcome =
  | "true_positive"
  | "benign_positive"
  | "false_positive"
  | "undetermined";

export type ReviewItem = {
  key: string;
  name: string;
  /** Context line captured when the item entered review, e.g. "Car · S · +20.0 z". */
  detail: string;
  status: ReviewStatus;
  outcome?: ReviewOutcome;
  note: string;
  openedAt: string;
  closedAt?: string;
};

export type ReviewState = { version: 1; items: Record<string, ReviewItem> };

export const OUTCOMES: { id: ReviewOutcome; label: string }[] = [
  { id: "true_positive", label: "True positive" },
  { id: "benign_positive", label: "Benign positive" },
  { id: "false_positive", label: "False positive" },
  { id: "undetermined", label: "Undetermined" },
];

export function outcomeLabel(outcome: ReviewOutcome | undefined): string {
  return OUTCOMES.find((entry) => entry.id === outcome)?.label ?? "Undetermined";
}

const DEFAULT_REVIEW: ReviewState = { version: 1, items: {} };

/** Place-level identity: one review item per countline × class × direction. */
export function signalKey(properties: Record<string, unknown>): string {
  const place = String(properties.countline_id ?? properties.name ?? "unknown");
  return [place, properties.transport_class ?? "", properties.direction ?? ""].join("|");
}

function normalise(raw: unknown): ReviewState {
  if (!raw || typeof raw !== "object") return DEFAULT_REVIEW;
  const items = (raw as { items?: unknown }).items;
  if (!items || typeof items !== "object") return DEFAULT_REVIEW;
  const cleaned: Record<string, ReviewItem> = {};
  for (const [key, value] of Object.entries(items as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const item = value as Partial<ReviewItem>;
    if (item.status !== "investigating" && item.status !== "closed") continue;
    cleaned[key] = {
      key,
      name: String(item.name ?? key),
      detail: String(item.detail ?? ""),
      status: item.status,
      outcome: OUTCOMES.some((entry) => entry.id === item.outcome)
        ? item.outcome
        : undefined,
      note: String(item.note ?? ""),
      openedAt: String(item.openedAt ?? ""),
      closedAt: item.closedAt ? String(item.closedAt) : undefined,
    };
  }
  return { version: 1, items: cleaned };
}

function loadReview(): ReviewState {
  if (typeof window === "undefined") return DEFAULT_REVIEW;
  try {
    const raw = window.localStorage.getItem(REVIEW_KEY);
    if (!raw) return DEFAULT_REVIEW;
    return normalise(JSON.parse(raw));
  } catch {
    return DEFAULT_REVIEW;
  }
}

const listeners = new Set<() => void>();
let cache: ReviewState | null = null;

export function subscribeReview(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function reviewSnapshot(): ReviewState {
  cache ??= loadReview();
  return cache;
}

/** SSR sees an empty queue; the browser's items arrive on first paint. */
export function serverReviewSnapshot(): ReviewState {
  return DEFAULT_REVIEW;
}

function writeReview(next: ReviewState) {
  cache = next;
  try {
    window.localStorage.setItem(REVIEW_KEY, JSON.stringify(next));
  } catch {
    /* Private-mode browsers refuse writes; the session still works in memory. */
  }
  listeners.forEach((listener) => listener());
}

export function openReview(key: string, name: string, detail: string) {
  const current = reviewSnapshot();
  const existing = current.items[key];
  writeReview({
    version: 1,
    items: {
      ...current.items,
      [key]: {
        key,
        name,
        detail,
        status: "investigating",
        note: existing?.note ?? "",
        openedAt: existing?.openedAt || new Date().toISOString(),
      },
    },
  });
}

export function closeReview(key: string, outcome: ReviewOutcome) {
  const current = reviewSnapshot();
  const existing = current.items[key];
  if (!existing) return;
  writeReview({
    version: 1,
    items: {
      ...current.items,
      [key]: { ...existing, status: "closed", outcome, closedAt: new Date().toISOString() },
    },
  });
}

export function reopenReview(key: string) {
  const current = reviewSnapshot();
  const existing = current.items[key];
  if (!existing) return;
  writeReview({
    version: 1,
    items: {
      ...current.items,
      [key]: {
        ...existing,
        status: "investigating",
        outcome: undefined,
        closedAt: undefined,
      },
    },
  });
}

/** Removes the working item; the signal returns to the implicit "new" queue. */
export function clearReview(key: string) {
  const current = reviewSnapshot();
  if (!current.items[key]) return;
  const items = { ...current.items };
  delete items[key];
  writeReview({ version: 1, items });
}

export function setReviewNote(key: string, note: string) {
  const current = reviewSnapshot();
  const existing = current.items[key];
  if (!existing) return;
  writeReview({
    version: 1,
    items: { ...current.items, [key]: { ...existing, note } },
  });
}
