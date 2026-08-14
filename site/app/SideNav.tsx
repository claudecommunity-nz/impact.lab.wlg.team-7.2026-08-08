"use client";

import { usePathname } from "next/navigation";
import { useCallback, useSyncExternalStore } from "react";

import { OPEN_AGENT_EVENT } from "./AgentChat";
import { createFlagStore } from "./flag-store";

/* Same key the bespoke store used, so remembered choices carry over. The rail
 * starts collapsed everywhere — an icon rail on desktop, an off-canvas drawer
 * on a small screen — and the server snapshot agrees, so it never renders
 * expanded first and folds after hydration. A stored choice still wins. */
const collapseStore = createFlagStore("murmur.nav.collapsed", true);

type NavItem = {
  href: string;
  label: string;
  detail: string;
  glyph: React.ReactNode;
};

/* Inline SVG rather than an icon font: the design system bans webfonts on the
 * emergency surface, and these have to survive a failed network. */
const MapGlyph = (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M2 5.2 7 3l6 2.2L18 3v11.8L13 17l-6-2.2L2 17z" />
    <path d="M7 3v11.8M13 5.2V17" className="stroke-only" />
  </svg>
);

const SourceGlyph = (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <ellipse cx="10" cy="5" rx="6.5" ry="2.6" />
    <path d="M3.5 5v5c0 1.4 2.9 2.6 6.5 2.6s6.5-1.2 6.5-2.6V5" className="stroke-only" />
    <path d="M3.5 10v5c0 1.4 2.9 2.6 6.5 2.6s6.5-1.2 6.5-2.6v-5" className="stroke-only" />
  </svg>
);

const PlugGlyph = (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M7 2v5M13 2v5" className="stroke-only" />
    <path d="M4.5 7h11v3a5.5 5.5 0 0 1-11 0z" />
    <path d="M10 15.5V18" className="stroke-only" />
  </svg>
);

const AgentGlyph = (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M3 4h14v9H9l-4 3.5V13H3z" />
  </svg>
);

const SparkGlyph = (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M10 2l1.8 5.2L17 9l-5.2 1.8L10 16l-1.8-5.2L3 9l5.2-1.8z" />
    <path d="M16 13l.9 2.1L19 16l-2.1.9L16 19l-.9-2.1L13 16l2.1-.9z" />
  </svg>
);

const QueueGlyph = (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M3 4.5 4.4 6 7 3.2" className="stroke-only" />
    <path d="M3 10.5 4.4 12 7 9.2" className="stroke-only" />
    <path d="M3 16.5 4.4 18 7 15.2" className="stroke-only" />
    <path d="M9 4.7h8M9 10.7h8M9 16.7h8" className="stroke-only" />
  </svg>
);

const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Operating picture", detail: "One map, every source", glyph: MapGlyph },
  {
    href: "/review",
    label: "Signal review",
    detail: "Triage, status and outcomes",
    glyph: QueueGlyph,
  },
  {
    href: "/settings",
    label: "Data sources",
    detail: "Status, sync, import and export",
    glyph: SourceGlyph,
  },
  {
    href: "/settings#integrations",
    label: "Integrations",
    detail: "APIs, MCP and A2A",
    glyph: PlugGlyph,
  },
  {
    href: "/settings#agent",
    label: "Agent setup",
    detail: "Link a model with your API key",
    glyph: SparkGlyph,
  },
];

export default function SideNav() {
  const pathname = usePathname();
  const collapsed =
    useSyncExternalStore(
      collapseStore.subscribe,
      collapseStore.snapshot,
      collapseStore.serverSnapshot,
    ) === "1";

  const toggle = useCallback(() => {
    collapseStore.toggle(collapsed);
  }, [collapsed]);

  /* On a small screen the open rail covers the map, so following a link also
   * puts it away; on desktop the rail stays. */
  const closeOnSmallScreen = useCallback(() => {
    if (!collapsed && window.matchMedia("(max-width: 900px)").matches) {
      collapseStore.toggle(false);
    }
  }, [collapsed]);

  const isActive = (href: string) => {
    const target = href.split("#")[0];
    return target === "/" ? pathname === "/" : pathname.startsWith(target);
  };

  return (
    <>
    <button
      type="button"
      className="nav-handle"
      onClick={toggle}
      aria-expanded={!collapsed}
      aria-controls="site-nav"
      title={collapsed ? "Show the navigator" : "Hide the navigator"}
    >
      <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
        {collapsed ? (
          <path
            d="M3 5h14M3 10h14M3 15h14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        ) : (
          <path
            d="M5 5l10 10M15 5L5 15"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        )}
      </svg>
      <span className="visually-hidden">
        {collapsed ? "Show the navigator" : "Hide the navigator"}
      </span>
    </button>
    <nav
      id="site-nav"
      className={`app-sidebar ${collapsed ? "collapsed" : ""}`}
      aria-label="Murmur sections"
      data-collapsed={collapsed ? "true" : "false"}
    >
      <button
        type="button"
        className="nav-toggle"
        onClick={toggle}
        aria-expanded={!collapsed}
        title={collapsed ? "Show the navigator" : "Hide the navigator"}
      >
        <span className="nav-toggle-glyph" aria-hidden="true">
          {collapsed ? "»" : "«"}
        </span>
        <span className="visually-hidden">
          {collapsed ? "Show the navigator" : "Hide the navigator"}
        </span>
      </button>

      <ul className="nav-items">
        {NAV_ITEMS.map((item) => (
          <li key={item.href}>
            {/* Plain anchors on purpose: vinext's client-side Link navigation
                is broken in production builds (the RSC prefetch chunk loses
                its exports), so every route change is a full page load. */}
            <a
              href={item.href}
              className={isActive(item.href) ? "active" : ""}
              aria-current={isActive(item.href) ? "page" : undefined}
              title={collapsed ? item.label : undefined}
              onClick={closeOnSmallScreen}
            >
              <span className="nav-glyph">{item.glyph}</span>
              <span className="nav-copy">
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </span>
            </a>
          </li>
        ))}
        <li>
          <button
            type="button"
            className="nav-agent"
            onClick={() => {
              closeOnSmallScreen();
              window.dispatchEvent(new CustomEvent(OPEN_AGENT_EVENT));
            }}
            title={collapsed ? "Ask the Murmur agent" : undefined}
          >
            <span className="nav-glyph">{AgentGlyph}</span>
            <span className="nav-copy">
              <strong>Ask the agent</strong>
              <small>Grounded in the published feeds</small>
            </span>
          </button>
        </li>
      </ul>

      <p className="nav-foot">
        <span>Batch replay</span>
        <small>Not live emergency information</small>
      </p>
    </nav>
    </>
  );
}
