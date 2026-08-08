"use client";

import { useCallback, useSyncExternalStore } from "react";

import {
  allSources,
  formatTimestamp,
  probesSnapshot,
  serverProbesSnapshot,
  serverSettingsSnapshot,
  settingsSnapshot,
  subscribeProbes,
  subscribeSettings,
} from "./data-sources";

const COLLAPSE_KEY = "murmur.intro.collapsed";
const COLLAPSE_EVENT = "murmur:intro-collapse";

/* Same store pattern as the rail: the choice is remembered, and nothing sets
 * state from an effect to discover it. */
function subscribeIntro(listener: () => void) {
  window.addEventListener(COLLAPSE_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(COLLAPSE_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

function introSnapshot(): string {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) ?? "0";
  } catch {
    return "0";
  }
}

const serverIntroSnapshot = () => "0";

/**
 * The briefing is for the first visit and the demo. Day to day an operator
 * wants the map, so the whole band folds down to the two facts that decide
 * whether the picture is worth trusting right now: how many sources are wired
 * in, and when anything last came back.
 */
export default function IntroBand({
  dataAsOf,
  children,
}: {
  dataAsOf: string;
  children: React.ReactNode;
}) {
  const collapsed = useSyncExternalStore(subscribeIntro, introSnapshot, serverIntroSnapshot) === "1";
  const settings = useSyncExternalStore(
    subscribeSettings,
    settingsSnapshot,
    serverSettingsSnapshot,
  );
  const probes = useSyncExternalStore(subscribeProbes, probesSnapshot, serverProbesSnapshot);

  const toggle = useCallback(() => {
    try {
      window.localStorage.setItem(COLLAPSE_KEY, collapsed ? "0" : "1");
    } catch {
      /* private mode: the choice simply does not persist */
    }
    window.dispatchEvent(new CustomEvent(COLLAPSE_EVENT));
  }, [collapsed]);

  const sourceCount = allSources(settings).length;
  // ISO strings sort lexicographically, so the last one is the most recent.
  const lastSync =
    Object.values(probes)
      .map((probe) => probe.lastSyncAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;

  return (
    <section className="brand-band" id="top">
      {collapsed ? (
        <div className="intro-strip">
          <p>
            <strong>{sourceCount}</strong> data sources
          </p>
          <p>
            {lastSync ? (
              <>
                Last sync <strong>{formatTimestamp(lastSync)}</strong>
              </>
            ) : (
              <>
                Not tested in this browser · publisher data through{" "}
                <strong>{dataAsOf}</strong>
              </>
            )}
          </p>
          <button
            type="button"
            className="intro-toggle"
            onClick={toggle}
            aria-expanded={false}
            aria-label="Show the brief"
            title="Show the brief"
          >
            <span aria-hidden="true">▾</span>
          </button>
        </div>
      ) : (
        <>
          <div className="intro-bar">
            <button
              type="button"
              className="intro-toggle"
              onClick={toggle}
              aria-expanded
              aria-label="Hide the brief"
              title="Hide the brief"
            >
              <span aria-hidden="true">▴</span>
            </button>
          </div>
          {children}
        </>
      )}
    </section>
  );
}
