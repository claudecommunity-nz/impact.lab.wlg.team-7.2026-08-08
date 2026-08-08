"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useSyncExternalStore } from "react";

import { OPEN_AGENT_EVENT } from "./AgentChat";

const COLLAPSE_KEY = "murmur.nav.collapsed";
const COLLAPSE_EVENT = "murmur:nav-collapse";

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

const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Operating picture", detail: "One map, every source", glyph: MapGlyph },
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
];

/* The collapsed flag lives in localStorage and is read through a store, so the
 * rail never has to set state from an effect to learn its own width. */
function subscribeCollapse(listener: () => void) {
  window.addEventListener(COLLAPSE_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(COLLAPSE_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

function collapseSnapshot(): string {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) ?? "0";
  } catch {
    return "0";
  }
}

const serverCollapseSnapshot = () => "0";

export default function SideNav() {
  const pathname = usePathname();
  const collapsed =
    useSyncExternalStore(subscribeCollapse, collapseSnapshot, serverCollapseSnapshot) === "1";

  const toggle = useCallback(() => {
    try {
      window.localStorage.setItem(COLLAPSE_KEY, collapsed ? "0" : "1");
    } catch {
      /* private mode: the choice simply does not persist */
    }
    window.dispatchEvent(new CustomEvent(COLLAPSE_EVENT));
  }, [collapsed]);

  const isActive = (href: string) => {
    const target = href.split("#")[0];
    return target === "/" ? pathname === "/" : pathname.startsWith(target);
  };

  return (
    <nav
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
        <span className="nav-toggle-label">Hide</span>
        <span className="visually-hidden">
          {collapsed ? "Show the navigator" : "Hide the navigator"}
        </span>
      </button>

      <ul className="nav-items">
        {NAV_ITEMS.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              className={isActive(item.href) ? "active" : ""}
              aria-current={isActive(item.href) ? "page" : undefined}
              title={collapsed ? item.label : undefined}
            >
              <span className="nav-glyph">{item.glyph}</span>
              <span className="nav-copy">
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </span>
            </Link>
          </li>
        ))}
        <li>
          <button
            type="button"
            className="nav-agent"
            onClick={() => window.dispatchEvent(new CustomEvent(OPEN_AGENT_EVENT))}
            title={collapsed ? "Ask the data agent" : undefined}
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
  );
}
