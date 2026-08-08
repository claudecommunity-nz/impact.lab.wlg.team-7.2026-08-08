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

export function createFlagStore(key: string, defaultOn: boolean): FlagStore {
  const event = `murmur:flag:${key}`;
  const fallback = defaultOn ? "1" : "0";

  return {
    subscribe(listener) {
      window.addEventListener(event, listener);
      // `storage` fires in the other tabs, so two windows stay in step.
      window.addEventListener("storage", listener);
      return () => {
        window.removeEventListener(event, listener);
        window.removeEventListener("storage", listener);
      };
    },
    snapshot() {
      try {
        return window.localStorage.getItem(key) ?? fallback;
      } catch {
        return fallback;
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
