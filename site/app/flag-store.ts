/**
 * A remembered on/off choice, read through `useSyncExternalStore`.
 *
 * The lint config forbids setting state from an effect, which is the usual way
 * a component discovers what `localStorage` already holds. Modelling the flag
 * as an external store instead keeps the server snapshot stable, hydration
 * quiet, and every panel that can be put away consistent with the others.
 */
export type FlagStore = {
  subscribe: (listener: () => void) => () => void;
  snapshot: () => string;
  serverSnapshot: () => string;
  /** Flip the stored value and tell every subscriber in this tab. */
  toggle: (current: boolean) => void;
};

/* Matches the breakpoint where the rail becomes a strip and the layout stacks:
 * on a screen that small the map is the page, so chrome may default closed. */
const SMALL_SCREEN_QUERY = "(max-width: 900px)";

export function createFlagStore(
  key: string,
  defaultOn: boolean,
  /** Fallback on small screens when nothing is stored; a saved choice wins. */
  smallScreenDefaultOn: boolean = defaultOn,
): FlagStore {
  const event = `murmur:flag:${key}`;
  const fallback = defaultOn ? "1" : "0";
  const smallFallback = smallScreenDefaultOn ? "1" : "0";

  const fallbackNow = () => {
    if (fallback === smallFallback) return fallback;
    try {
      return window.matchMedia(SMALL_SCREEN_QUERY).matches ? smallFallback : fallback;
    } catch {
      return fallback;
    }
  };

  return {
    subscribe(listener) {
      window.addEventListener(event, listener);
      // `storage` fires in the other tabs, so two windows stay in step.
      window.addEventListener("storage", listener);
      // Crossing the breakpoint changes the unstored fallback, so resubmit it.
      const media =
        fallback !== smallFallback && "matchMedia" in window
          ? window.matchMedia(SMALL_SCREEN_QUERY)
          : null;
      media?.addEventListener?.("change", listener);
      return () => {
        window.removeEventListener(event, listener);
        window.removeEventListener("storage", listener);
        media?.removeEventListener?.("change", listener);
      };
    },
    snapshot() {
      try {
        return window.localStorage.getItem(key) ?? fallbackNow();
      } catch {
        return fallbackNow();
      }
    },
    serverSnapshot() {
      return fallback;
    },
    toggle(current) {
      try {
        window.localStorage.setItem(key, current ? "0" : "1");
      } catch {
        /* private mode: the choice simply does not persist */
      }
      window.dispatchEvent(new CustomEvent(event));
    },
  };
}
