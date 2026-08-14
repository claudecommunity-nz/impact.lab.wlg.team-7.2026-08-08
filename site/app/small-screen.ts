/**
 * Whether the viewport is in the stacked small-screen layout, read through
 * `useSyncExternalStore` like every remembered flag — components never probe
 * `matchMedia` during render, and the server snapshot stays the desktop one.
 */
const SMALL_SCREEN_QUERY = "(max-width: 900px)";

export function subscribeSmallScreen(listener: () => void) {
  const media = window.matchMedia(SMALL_SCREEN_QUERY);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

export function smallScreenSnapshot(): boolean {
  try {
    return window.matchMedia(SMALL_SCREEN_QUERY).matches;
  } catch {
    return false;
  }
}

export const serverSmallScreenSnapshot = () => false;
