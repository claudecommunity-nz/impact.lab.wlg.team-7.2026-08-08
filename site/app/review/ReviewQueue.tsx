"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { download } from "../data-sources";
import {
  OUTCOMES,
  clearReview,
  closeReview,
  openReview,
  outcomeLabel,
  reopenReview,
  reviewSnapshot,
  serverReviewSnapshot,
  setReviewNote,
  signalKey,
  subscribeReview,
  type ReviewStatus,
} from "../review-store";

type SignalFeature = {
  id: string;
  properties: Record<string, unknown>;
};

type Row = {
  key: string;
  name: string;
  detail: string;
  z: number | null;
  direction: string | null;
  status: "new" | ReviewStatus;
};

type View = "new" | "active" | "closed" | "all";

const VIEWS: { id: View; label: string }[] = [
  { id: "new", label: "New" },
  { id: "active", label: "Active" },
  { id: "closed", label: "Closed" },
  { id: "all", label: "All" },
];

const STATUS_VIEW: Record<Row["status"], View> = {
  new: "new",
  investigating: "active",
  closed: "closed",
};

function statusBadge(status: Row["status"]) {
  if (status === "investigating") return <em className="status-badge review-active">Active</em>;
  if (status === "closed") return <em className="status-badge review-closed">Closed</em>;
  return <em className="status-badge review-new">New</em>;
}

export default function ReviewQueue() {
  const review = useSyncExternalStore(subscribeReview, reviewSnapshot, serverReviewSnapshot);
  const [signals, setSignals] = useState<SignalFeature[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/cop/v1/movement-signals.geojson")
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((collection: { features: SignalFeature[] }) => {
        if (!cancelled) setSignals(collection.features);
      })
      .catch(() => {
        if (!cancelled) setError("Signal feed unreachable.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo<Row[]>(() => {
    const seeded: Row[] = signals
      .map((feature) => {
        const key = signalKey(feature.properties);
        const item = review.items[key];
        return {
          key,
          name: String(feature.properties.name),
          detail: `${String(feature.properties.transport_class)} · ${String(feature.properties.direction)}`,
          z: Number(feature.properties.robust_z),
          direction: String(feature.properties.change_direction),
          status: (item?.status ?? "new") as Row["status"],
        };
      })
      .sort((a, b) => Math.abs(b.z ?? 0) - Math.abs(a.z ?? 0));
    const seededKeys = new Set(seeded.map((row) => row.key));
    // Items sent from the map that are not in the snapshot feed (e.g. April
    // backtest streets) still appear, under the facts captured at entry.
    const extras: Row[] = Object.values(review.items)
      .filter((item) => !seededKeys.has(item.key))
      .sort((a, b) => (b.openedAt > a.openedAt ? 1 : -1))
      .map((item) => ({
        key: item.key,
        name: item.name,
        detail: item.detail,
        z: null,
        direction: null,
        status: item.status,
      }));
    return [...seeded, ...extras];
  }, [signals, review]);

  const counts = useMemo(() => {
    const tally: Record<View, number> = { new: 0, active: 0, closed: 0, all: rows.length };
    for (const row of rows) tally[STATUS_VIEW[row.status]] += 1;
    return tally;
  }, [rows]);

  const shown = view === "all" ? rows : rows.filter((row) => STATUS_VIEW[row.status] === view);
  const selected = shown.find((row) => row.key === selectedKey) ?? shown[0] ?? null;
  const selectedItem = selected ? review.items[selected.key] : undefined;

  /* Same composable-output rule as every Murmur surface: the queue leaves as a
   * versioned JSON contract, truth boundaries attached. */
  const exportQueue = () => {
    download(
      "murmur-review.json",
      JSON.stringify(
        {
          schema: "movement-review/v1",
          generated_at: new Date().toISOString(),
          source: "/cop/v1/movement-signals.geojson",
          browser_local: true,
          limitations: [
            "Browser-local working notes, never a Council record.",
            "A signal means investigate; no status confirms an incident.",
          ],
          items: rows.map((row) => {
            const item = review.items[row.key];
            return {
              key: row.key,
              name: row.name,
              detail: row.detail,
              robust_z: row.z,
              status: row.status,
              outcome: item?.outcome ?? null,
              note: item?.note ?? "",
              opened_at: item?.openedAt || null,
              closed_at: item?.closedAt ?? null,
            };
          }),
        },
        null,
        2,
      ),
      "application/json",
    );
  };

  return (
    <section className="review-shell" aria-labelledby="review-queues-heading">
      <div className="review-list-column">
        <h2 id="review-queues-heading" className="visually-hidden">
          Review queues
        </h2>
        <div className="filter-group review-views" role="group" aria-label="Review queues">
          {VIEWS.map((entry) => (
            <button
              type="button"
              key={entry.id}
              className={view === entry.id ? "active" : ""}
              aria-pressed={view === entry.id}
              onClick={() => setView(entry.id)}
            >
              {entry.label} ({counts[entry.id]})
            </button>
          ))}
        </div>
        <div className="evidence-ops review-export">
          <button type="button" onClick={exportQueue} disabled={rows.length === 0}>
            Export queue (JSON)
          </button>
        </div>
        <div className="signal-list review-list" aria-label="Signals in this queue">
          {shown.map((row) => (
            <button
              type="button"
              key={row.key}
              className={selected?.key === row.key ? "selected" : ""}
              onClick={() => setSelectedKey(row.key)}
            >
              <span>
                <strong>{row.name}</strong>
                <small>{row.detail}</small>
              </span>
              {statusBadge(row.status)}
            </button>
          ))}
          {shown.length === 0 ? (
            <p className="empty-evidence">
              {error ?? (signals.length === 0 ? "Loading the signal feed…" : "No signals in this queue.")}
            </p>
          ) : null}
        </div>
      </div>

      <div className="review-detail">
        {selected ? (
          <div className="selected-evidence">
            <div className="evidence-heading">
              {statusBadge(selected.status)}
              <span>Investigate</span>
            </div>
            <h3>{selected.name}</h3>
            <p>
              {selected.detail}
              {selected.z !== null ? (
                <>
                  {" · "}
                  <span className={selected.direction ?? undefined}>
                    {selected.z > 0 ? "+" : ""}
                    {selected.z.toFixed(1)} z
                  </span>
                </>
              ) : null}
            </p>

            {selected.status === "new" ? (
              <div className="evidence-ops review-actions">
                <button
                  type="button"
                  onClick={() => openReview(selected.key, selected.name, selected.detail)}
                >
                  Start investigating
                </button>
              </div>
            ) : null}

            {selected.status === "investigating" ? (
              <>
                <p className="review-close-label" id={`close-as-${selected.key}`}>
                  Close as
                </p>
                <div
                  className="filter-group review-outcomes"
                  role="group"
                  aria-labelledby={`close-as-${selected.key}`}
                >
                  {OUTCOMES.map((outcome) => (
                    <button
                      type="button"
                      key={outcome.id}
                      onClick={() => closeReview(selected.key, outcome.id)}
                    >
                      {outcome.label}
                    </button>
                  ))}
                </div>
                <div className="evidence-ops review-actions">
                  <button type="button" onClick={() => clearReview(selected.key)}>
                    Return to new
                  </button>
                </div>
              </>
            ) : null}

            {selected.status === "closed" ? (
              <>
                <dl className="evidence-metrics">
                  <div>
                    <dt>Outcome</dt>
                    <dd>{outcomeLabel(selectedItem?.outcome)}</dd>
                  </div>
                  {selectedItem?.closedAt ? (
                    <div>
                      <dt>Closed</dt>
                      <dd>{selectedItem.closedAt.slice(0, 16).replace("T", " ")}</dd>
                    </div>
                  ) : null}
                </dl>
                <div className="evidence-ops review-actions">
                  <button type="button" onClick={() => reopenReview(selected.key)}>
                    Reopen
                  </button>
                </div>
              </>
            ) : null}

            {selectedItem ? (
              <label className="review-note">
                <span>Notes · stored in this browser</span>
                <textarea
                  value={selectedItem.note}
                  onChange={(event) => setReviewNote(selected.key, event.currentTarget.value)}
                  rows={4}
                />
              </label>
            ) : null}

            <p className="evidence-note">
              A signal means investigate. No status here confirms an incident.
            </p>
            <div className="evidence-ops">
              <a href="/cop/v1/movement-signals.geojson" target="_blank" rel="noreferrer">
                Open feed
              </a>
              <Link href="/">Operating picture</Link>
            </div>
          </div>
        ) : (
          <p className="empty-evidence">Select a signal to triage it.</p>
        )}
      </div>
    </section>
  );
}
