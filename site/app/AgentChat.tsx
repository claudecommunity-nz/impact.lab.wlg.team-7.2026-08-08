"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  type Brief,
  EMPTY_BRIEF,
  SUGGESTED_QUESTIONS,
  answer,
  briefContext,
  loadBrief,
} from "./agent-brief";
import { agentIsConfigured, agentTarget, askModel } from "./agent-providers";
import { serverSettingsSnapshot, settingsSnapshot, subscribeSettings } from "./data-sources";

type Message = {
  id: number;
  role: "you" | "agent";
  text: string;
  sources: string[];
  pending?: boolean;
};

export const OPEN_AGENT_EVENT = "murmur:open-agent";

const GREETING: Message = {
  id: 0,
  role: "agent",
  text: "I read the published Murmur artifacts and answer from those numbers only. Ask what changed, how reliable it is, or about a street.",
  sources: [],
};

export default function AgentChat() {
  const [open, setOpen] = useState(false);
  const [maximised, setMaximised] = useState(false);
  const [brief, setBrief] = useState<Brief>(EMPTY_BRIEF);
  const [messages, setMessages] = useState<Message[]>([GREETING]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  // Live view of the settings store: linking a provider in Agent setup takes
  // effect immediately, even while this panel is already open.
  const agent = useSyncExternalStore(
    subscribeSettings,
    settingsSnapshot,
    serverSettingsSnapshot,
  ).agent;
  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);
  const loadedRef = useRef(false);

  /**
   * Opening is the moment the agent needs the world: the artifacts load once,
   * so the map keeps the initial network budget to itself.
   */
  const openPanel = useCallback(() => {
    setOpen(true);
    if (!loadedRef.current) {
      loadedRef.current = true;
      loadBrief().then(setBrief);
    }
  }, []);

  // The sidebar and anything else can open the chat without prop drilling.
  useEffect(() => {
    window.addEventListener(OPEN_AGENT_EVENT, openPanel);
    return () => window.removeEventListener(OPEN_AGENT_EVENT, openPanel);
  }, [openPanel]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Escape backs out one step: full screen first, then the panel itself.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (maximised) setMaximised(false);
      else setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, maximised]);

  const close = useCallback(() => {
    setOpen(false);
    setMaximised(false);
  }, []);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages]);

  const ask = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (!trimmed || busy) return;
      setDraft("");
      setBusy(true);
      const askedId = nextId.current++;
      const replyId = nextId.current++;
      setMessages((current) => [
        ...current,
        { id: askedId, role: "you", text: trimmed, sources: [] },
        { id: replyId, role: "agent", text: "Reading the artifacts…", sources: [], pending: true },
      ]);

      let reply: Message;
      if (agentIsConfigured(agent)) {
        try {
          reply = {
            id: replyId,
            role: "agent",
            text: await askModel(trimmed, briefContext(brief), agent),
            sources: [agentTarget(agent)],
          };
        } catch (error) {
          const local = answer(trimmed, brief);
          reply = {
            id: replyId,
            role: "agent",
            text: `${agentTarget(agent)} failed (${
              error instanceof Error ? error.message : "unreachable"
            }). Answering locally instead.\n\n${local.text}`,
            sources: local.sources,
          };
        }
      } else {
        reply = { id: replyId, role: "agent", ...answer(trimmed, brief) };
      }

      setMessages((current) =>
        current.map((message) => (message.id === replyId ? reply : message)),
      );
      setBusy(false);
      inputRef.current?.focus();
    },
    [agent, brief, busy],
  );

  return (
    <>
      <button
        type="button"
        className={`agent-fab ${open ? "open" : ""}`}
        aria-expanded={open}
        aria-controls="agent-panel"
        onClick={() => (open ? close() : openPanel())}
      >
        <span className="agent-fab-glyph" aria-hidden="true">
          {open ? "×" : "✦"}
        </span>
        <span className="visually-hidden">
          {open ? "Close the Murmur agent" : "Ask the Murmur agent"}
        </span>
      </button>

      {open ? (
        <section
          className={`agent-panel ${maximised ? "max" : ""}`}
          id="agent-panel"
          aria-label="Ask the Murmur agent"
        >
          <header className="agent-panel-head">
            <div>
              <p className="eyebrow">Murmur agent</p>
              <h2>Ask about this operating picture</h2>
            </div>
            <div className="agent-panel-actions">
              <button
                type="button"
                onClick={() => setMaximised((current) => !current)}
                aria-pressed={maximised}
                aria-label={maximised ? "Exit full screen" : "Expand to full screen"}
                title={maximised ? "Exit full screen" : "Expand to full screen"}
              >
                <span aria-hidden="true">{maximised ? "⤡" : "⤢"}</span>
              </button>
              <button type="button" onClick={close} aria-label="Close the agent">
                ×
              </button>
            </div>
          </header>

          <p className="agent-provenance">
            {agentIsConfigured(agent)
              ? `Routed to ${agentTarget(agent)} — your key stays in this browser, and the published artifacts go along as context. Change it under Settings → Agent setup.`
              : `Grounded answers assembled from the committed artifacts — ${brief.signals.length} signals, ${brief.coverageCount} countlines, ${brief.cameras.length} cameras, ${brief.transit.length} PT hotspots. No cause inferred.`}
          </p>

          <div className="agent-log" ref={logRef} role="log" aria-live="polite">
            {messages.map((message) => (
              <article key={message.id} className={`agent-message ${message.role}`}>
                <p className="agent-role">{message.role === "you" ? "You" : "Agent"}</p>
                <div className={message.pending ? "agent-text pending" : "agent-text"}>
                  {message.text.split("\n").map((line, index) => (
                    <p key={index}>{line}</p>
                  ))}
                </div>
                {message.sources.length > 0 ? (
                  <p className="agent-sources">
                    {message.sources.map((source) => (
                      <span key={source}>{source}</span>
                    ))}
                  </p>
                ) : null}
              </article>
            ))}
          </div>

          {messages.length === 1 ? (
            <div className="agent-suggestions">
              {SUGGESTED_QUESTIONS.map((question) => (
                <button type="button" key={question} onClick={() => ask(question)}>
                  {question}
                </button>
              ))}
            </div>
          ) : null}

          <form
            className="agent-form"
            onSubmit={(event) => {
              event.preventDefault();
              ask(draft);
            }}
          >
            <label className="visually-hidden" htmlFor="agent-input">
              Ask the Murmur agent a question
            </label>
            <input
              id="agent-input"
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Which signal dropped the most?"
              autoComplete="off"
            />
            <button type="submit" disabled={busy || draft.trim().length === 0}>
              {busy ? "…" : "Ask"}
            </button>
          </form>

          <p className="agent-footnote">
            Not live emergency information. In an emergency, call 111. Answers describe
            published batch data, never an incident.
          </p>
        </section>
      ) : null}
    </>
  );
}
