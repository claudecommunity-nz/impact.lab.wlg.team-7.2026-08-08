"use client";

import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  type DataSource,
  type Integration,
  type IntegrationKind,
  type Settings,
  type SourceFormat,
  BUILTIN_SOURCES,
  FORMAT_LABELS,
  STATUS_LABELS,
  agentCard,
  allSources,
  download,
  exportSource,
  formatTimestamp,
  isLocal,
  mcpTemplate,
  missingUploadProbe,
  noopSubscribe,
  normaliseSettings,
  originSnapshot,
  probeIntegration,
  probeLocal,
  probeSource,
  probesSnapshot,
  relativeTime,
  serverProbesSnapshot,
  serverSettingsSnapshot,
  settingsSnapshot,
  subscribeProbes,
  subscribeSettings,
  uniqueId,
  writeProbe,
  writeSettings,
  LOCAL_PREFIX,
} from "./data-sources";

const FORMATS = Object.keys(FORMAT_LABELS) as SourceFormat[];

const INTEGRATION_KINDS: { id: IntegrationKind; label: string; hint: string }[] = [
  { id: "rest", label: "REST API", hint: "A URL this browser can GET or POST." },
  { id: "mcp", label: "MCP server", hint: "Model Context Protocol endpoint or command." },
  { id: "a2a", label: "A2A agent", hint: "Another agent's card or JSON-RPC endpoint." },
  { id: "webhook", label: "Webhook", hint: "Where Murmur should push a signal batch." },
];

const EMPTY_SOURCE = {
  label: "",
  publisher: "",
  url: "",
  format: "geojson" as SourceFormat,
  cadence: "",
};

const EMPTY_INTEGRATION = {
  kind: "rest" as IntegrationKind,
  label: "",
  url: "",
  token: "",
};

export default function SettingsPanel() {
  // Settings, probes and the origin come from stores rather than effects, so
  // nothing has to set state during hydration.
  const settings = useSyncExternalStore(
    subscribeSettings,
    settingsSnapshot,
    serverSettingsSnapshot,
  );
  const probes = useSyncExternalStore(subscribeProbes, probesSnapshot, serverProbesSnapshot);
  const origin = useSyncExternalStore(noopSubscribe, originSnapshot, () => "");
  /** Imported files stay in this tab: parsed here, never uploaded anywhere. */
  const [uploads, setUploads] = useState<Record<string, string>>({});
  const [exportFormats, setExportFormats] = useState<Record<string, SourceFormat>>({});
  const [draftSource, setDraftSource] = useState(EMPTY_SOURCE);
  const [draftIntegration, setDraftIntegration] = useState(EMPTY_INTEGRATION);
  const [notice, setNotice] = useState<string | null>(null);
  const configInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const update = useCallback((next: Settings) => writeSettings(next), []);

  const sources = useMemo(() => allSources(settings), [settings]);

  const test = useCallback(
    async (source: DataSource) => {
      if (isLocal(source)) {
        const text = uploads[source.id];
        writeProbe(source.id, text ? probeLocal(text, source.format) : missingUploadProbe());
        return;
      }
      const previous = probesSnapshot()[source.id];
      writeProbe(source.id, {
        status: "checking",
        checkedAt: null,
        lastSyncAt: previous?.lastSyncAt ?? null,
        latencyMs: null,
        recordCount: null,
        message: "Requesting…",
      });
      writeProbe(source.id, await probeSource(source, previous));
    },
    [uploads],
  );

  const testAll = useCallback(async () => {
    setNotice(`Testing ${sources.length} sources…`);
    await Promise.all(sources.map((source) => test(source)));
    setNotice(`Tested ${sources.length} sources.`);
  }, [sources, test]);

  const doExport = async (source: DataSource) => {
    const format = exportFormats[source.id] ?? source.format;
    try {
      await exportSource(source, format, uploads[source.id]);
      setNotice(`Exported ${source.label} as ${FORMAT_LABELS[format]}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Export failed.");
    }
  };

  const addSource = (event: React.FormEvent) => {
    event.preventDefault();
    if (!draftSource.url.trim()) return;
    const id = uniqueId("custom", sources.map((source) => source.id));
    update({
      ...settings,
      sources: [
        ...settings.sources,
        {
          id,
          label: draftSource.label.trim() || draftSource.url.trim(),
          publisher: draftSource.publisher.trim() || "Publisher not stated",
          url: draftSource.url.trim(),
          format: draftSource.format,
          kind: "custom",
          cadence: draftSource.cadence.trim() || "cadence not stated",
          note: "Added in this browser. Stored locally, never published by this repo.",
        },
      ],
    });
    setDraftSource(EMPTY_SOURCE);
    setNotice("Source added. Test it to record a status and last sync.");
  };

  const removeSource = (id: string) => {
    update({ ...settings, sources: settings.sources.filter((source) => source.id !== id) });
    setUploads((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  };

  const importFile = async (file: File) => {
    const text = await file.text();
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    const format: SourceFormat =
      extension === "geojson"
        ? "geojson"
        : extension === "csv"
          ? "csv"
          : extension === "ndjson" || extension === "jsonl"
            ? "ndjson"
            : "json";
    const id = uniqueId("upload", sources.map((source) => source.id));
    setUploads((current) => ({ ...current, [id]: text }));
    update({
      ...settings,
      sources: [
        ...settings.sources,
        {
          id,
          label: file.name,
          publisher: "Imported in this browser",
          url: `${LOCAL_PREFIX}${file.name}`,
          format,
          kind: "custom",
          cadence: "one-off import",
          note: "Held in this tab only. Nothing is uploaded, and it is gone on reload.",
        },
      ],
    });
    writeProbe(id, probeLocal(text, format));
    setNotice(`Imported ${file.name}. Export it in any format below.`);
  };

  const importConfig = async (file: File) => {
    try {
      const next = normaliseSettings(JSON.parse(await file.text()));
      update(next);
      setNotice(`Loaded ${next.sources.length} sources and ${next.integrations.length} integrations.`);
    } catch {
      setNotice("That file is not a Murmur settings export.");
    }
  };

  const exportConfig = () => {
    // Deliberately omits secrets: a shared config should never carry a key.
    const safe: Settings = {
      ...settings,
      agent: { ...settings.agent, apiKey: "" },
      integrations: settings.integrations.map((entry) => ({ ...entry, token: "" })),
    };
    download("murmur-settings.json", JSON.stringify(safe, null, 2), "application/json");
    setNotice("Config exported without tokens or keys.");
  };

  const addIntegration = (event: React.FormEvent) => {
    event.preventDefault();
    if (!draftIntegration.url.trim()) return;
    update({
      ...settings,
      integrations: [
        ...settings.integrations,
        {
          id: uniqueId("integration", settings.integrations.map((entry) => entry.id)),
          kind: draftIntegration.kind,
          label: draftIntegration.label.trim() || draftIntegration.url.trim(),
          url: draftIntegration.url.trim(),
          token: draftIntegration.token,
          enabled: true,
        },
      ],
    });
    setDraftIntegration(EMPTY_INTEGRATION);
    setNotice("Integration added.");
  };

  const testIntegration = async (integration: Integration) => {
    setNotice(`Testing ${integration.label}…`);
    setNotice(await probeIntegration(integration));
  };

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(`${label} copied.`);
    } catch {
      setNotice("The browser refused clipboard access. Use the download button instead.");
    }
  };

  const card = useMemo(
    () => JSON.stringify(agentCard(origin || "https://murmur.example", settings.agent.endpoint), null, 2),
    [origin, settings.agent.endpoint],
  );
  const mcp = useMemo(
    () => JSON.stringify(mcpTemplate(origin || "https://murmur.example"), null, 2),
    [origin],
  );

  return (
    <div className="settings-shell">
      {notice ? (
        <p className="settings-notice" role="status">
          {notice}
        </p>
      ) : null}

      <section className="settings-block" aria-labelledby="sources-heading">
        <div className="settings-block-head">
          <div>
            <p className="eyebrow">Connected data</p>
            <h2 id="sources-heading">Data sources</h2>
            <p className="settings-lede">
              The five committed files are the contract this site reads. Anything you add
              lives in this browser only — no endpoint or token you type here is published
              by the repository.
            </p>
          </div>
          <button type="button" className="button-primary" onClick={testAll}>
            Test all
          </button>
        </div>

        <table className="source-table">
          <caption className="visually-hidden">
            Data sources with status, last successful sync and export controls
          </caption>
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Status</th>
              <th scope="col">Last sync</th>
              <th scope="col">Export</th>
              <th scope="col"><span className="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {sources.map((source) => {
              const probe = probes[source.id];
              const status = probe?.status ?? "unknown";
              return (
                <tr key={source.id}>
                  <th scope="row">
                    <strong>{source.label}</strong>
                    <small>{source.publisher}</small>
                    <code>{source.url}</code>
                    <span className="format-chip">{FORMAT_LABELS[source.format]}</span>
                    {source.kind === "custom" ? <span className="format-chip custom">local</span> : null}
                  </th>
                  <td>
                    <span className={`status-pill ${status}`}>
                      <i aria-hidden="true" />
                      {STATUS_LABELS[status]}
                    </span>
                    <small>
                      {probe
                        ? `${probe.message}${probe.latencyMs !== null ? ` · ${probe.latencyMs} ms` : ""}`
                        : source.cadence}
                    </small>
                  </td>
                  <td>
                    <strong>{relativeTime(probe?.lastSyncAt ?? null)}</strong>
                    <small>
                      {probe?.lastSyncAt ? formatTimestamp(probe.lastSyncAt) : "never fetched here"}
                    </small>
                  </td>
                  <td>
                    <div className="export-control">
                      <label className="visually-hidden" htmlFor={`format-${source.id}`}>
                        Export format for {source.label}
                      </label>
                      <select
                        id={`format-${source.id}`}
                        value={exportFormats[source.id] ?? source.format}
                        onChange={(event) =>
                          setExportFormats((current) => ({
                            ...current,
                            [source.id]: event.target.value as SourceFormat,
                          }))
                        }
                      >
                        {FORMATS.map((format) => (
                          <option key={format} value={format}>
                            {FORMAT_LABELS[format]}
                          </option>
                        ))}
                      </select>
                      <button type="button" onClick={() => doExport(source)}>
                        Export
                      </button>
                    </div>
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => test(source)}
                        title={`Test ${source.label}`}
                      >
                        <span aria-hidden="true">↻</span>
                        <span className="visually-hidden">
                          Test or retry {source.label}
                        </span>
                      </button>
                      {source.kind === "custom" ? (
                        <button
                          type="button"
                          className="icon-button danger"
                          onClick={() => removeSource(source.id)}
                          title={`Remove ${source.label}`}
                        >
                          <span aria-hidden="true">✕</span>
                          <span className="visually-hidden">Remove {source.label}</span>
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="settings-note">
          Status is measured, not asserted: reachable, reachable with an unexpected body,
          or failed. A source the browser cannot reach because of CORS reads as failed
          here and may still be healthy for a server-side client.
        </p>
      </section>

      <section className="settings-block" aria-labelledby="add-heading">
        <p className="eyebrow">Input</p>
        <h2 id="add-heading">Add a source</h2>
        <form className="settings-form" onSubmit={addSource}>
          <label>
            <span>Label</span>
            <input
              value={draftSource.label}
              onChange={(event) => setDraftSource({ ...draftSource, label: event.target.value })}
              placeholder="Road closures"
            />
          </label>
          <label>
            <span>Publisher</span>
            <input
              value={draftSource.publisher}
              onChange={(event) => setDraftSource({ ...draftSource, publisher: event.target.value })}
              placeholder="Wellington City Council"
            />
          </label>
          <label className="wide">
            <span>URL</span>
            <input
              required
              value={draftSource.url}
              onChange={(event) => setDraftSource({ ...draftSource, url: event.target.value })}
              placeholder="https://example.govt.nz/layer.geojson"
            />
          </label>
          <label>
            <span>Format</span>
            <select
              value={draftSource.format}
              onChange={(event) =>
                setDraftSource({ ...draftSource, format: event.target.value as SourceFormat })
              }
            >
              {FORMATS.map((format) => (
                <option key={format} value={format}>
                  {FORMAT_LABELS[format]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Cadence</span>
            <input
              value={draftSource.cadence}
              onChange={(event) => setDraftSource({ ...draftSource, cadence: event.target.value })}
              placeholder="hourly"
            />
          </label>
          <div className="form-actions">
            <button type="submit" className="button-primary">Add source</button>
            <button type="button" onClick={() => fileInput.current?.click()}>
              Import a file
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".json,.geojson,.csv,.ndjson,.jsonl,application/json,text/csv"
              className="visually-hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) importFile(file);
                event.target.value = "";
              }}
            />
            <button type="button" onClick={() => configInput.current?.click()}>
              Load config
            </button>
            <input
              ref={configInput}
              type="file"
              accept="application/json,.json"
              className="visually-hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) importConfig(file);
                event.target.value = "";
              }}
            />
            <button type="button" onClick={exportConfig}>
              Export config
            </button>
          </div>
        </form>
      </section>

      <section className="settings-block" id="integrations" aria-labelledby="integrations-heading">
        <p className="eyebrow">Machine to machine</p>
        <h2 id="integrations-heading">Integrations</h2>
        <p className="settings-lede">
          Each team&rsquo;s module feeds one shared operating picture, so the feed is the
          product and the map is only a view. Register the endpoints you want this browser
          to talk to, then test them.
        </p>

        {settings.integrations.length > 0 ? (
          <ul className="integration-list">
            {settings.integrations.map((integration) => (
              <li key={integration.id}>
                <span className={`kind-chip ${integration.kind}`}>{integration.kind}</span>
                <span className="integration-copy">
                  <strong>{integration.label}</strong>
                  <code>{integration.url}</code>
                </span>
                <span className="row-actions">
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => testIntegration(integration)}
                    title={`Test ${integration.label}`}
                  >
                    <span aria-hidden="true">↻</span>
                    <span className="visually-hidden">Test {integration.label}</span>
                  </button>
                  <button
                    type="button"
                    className="icon-button danger"
                    onClick={() =>
                      update({
                        ...settings,
                        integrations: settings.integrations.filter(
                          (entry) => entry.id !== integration.id,
                        ),
                      })
                    }
                    title={`Remove ${integration.label}`}
                  >
                    <span aria-hidden="true">✕</span>
                    <span className="visually-hidden">Remove {integration.label}</span>
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="settings-empty">No integrations registered in this browser yet.</p>
        )}

        <form className="settings-form" onSubmit={addIntegration}>
          <label>
            <span>Kind</span>
            <select
              value={draftIntegration.kind}
              onChange={(event) =>
                setDraftIntegration({
                  ...draftIntegration,
                  kind: event.target.value as IntegrationKind,
                })
              }
            >
              {INTEGRATION_KINDS.map((kind) => (
                <option key={kind.id} value={kind.id}>
                  {kind.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Label</span>
            <input
              value={draftIntegration.label}
              onChange={(event) =>
                setDraftIntegration({ ...draftIntegration, label: event.target.value })
              }
              placeholder="Team 3 hazard agent"
            />
          </label>
          <label className="wide">
            <span>URL or command</span>
            <input
              required
              value={draftIntegration.url}
              onChange={(event) =>
                setDraftIntegration({ ...draftIntegration, url: event.target.value })
              }
              placeholder="https://agent.example/.well-known/agent-card.json"
            />
          </label>
          <label>
            <span>Token (optional)</span>
            <input
              type="password"
              value={draftIntegration.token}
              onChange={(event) =>
                setDraftIntegration({ ...draftIntegration, token: event.target.value })
              }
              placeholder="stored in this browser only"
            />
          </label>
          <div className="form-actions">
            <button type="submit" className="button-primary">Add integration</button>
            <span className="field-hint">
              {INTEGRATION_KINDS.find((kind) => kind.id === draftIntegration.kind)?.hint}
            </span>
          </div>
        </form>

        <div className="config-grid">
          <article>
            <h3>MCP server config</h3>
            <p>
              The feeds are static files, so any HTTP-capable MCP server can serve them.
              Paste this into your MCP client config and point the fetch tool at the URLs.
            </p>
            <pre>{mcp}</pre>
            <div className="form-actions">
              <button type="button" onClick={() => copy("MCP config", mcp)}>Copy</button>
              <button
                type="button"
                onClick={() => download("murmur-mcp.json", mcp, "application/json")}
              >
                Download
              </button>
            </div>
          </article>
          <article>
            <h3>A2A agent card</h3>
            <p>
              Generated for the endpoint you configure below, not committed to the repo —
              a card checked into <code>public/</code> would advertise a URL that answers
              nothing. Serve it at <code>/.well-known/agent-card.json</code> once your
              agent is actually hosted.
            </p>
            <pre>{card}</pre>
            <div className="form-actions">
              <button type="button" onClick={() => copy("Agent card", card)}>Copy</button>
              <button
                type="button"
                onClick={() => download("agent-card.json", card, "application/json")}
              >
                Download
              </button>
            </div>
          </article>
        </div>
      </section>

      <section className="settings-block" aria-labelledby="agent-heading">
        <p className="eyebrow">Chat</p>
        <h2 id="agent-heading">Agent endpoint</h2>
        <p className="settings-lede">
          Leave this empty and the chat answers locally from the published artifacts, which
          is the honest default: it cannot invent a signal that is not in the feed. Set an
          endpoint and each question is POSTed there with the same artifacts as context.
        </p>
        <form className="settings-form" onSubmit={(event) => event.preventDefault()}>
          <label className="wide">
            <span>Endpoint</span>
            <input
              value={settings.agent.endpoint}
              onChange={(event) =>
                update({ ...settings, agent: { ...settings.agent, endpoint: event.target.value } })
              }
              placeholder="https://your-worker.example/agent"
            />
          </label>
          <label>
            <span>Model</span>
            <input
              value={settings.agent.model}
              onChange={(event) =>
                update({ ...settings, agent: { ...settings.agent, model: event.target.value } })
              }
              placeholder="claude-opus-5"
            />
          </label>
          <label>
            <span>API key</span>
            <input
              type="password"
              value={settings.agent.apiKey}
              onChange={(event) =>
                update({ ...settings, agent: { ...settings.agent, apiKey: event.target.value } })
              }
              placeholder="stored in this browser only"
            />
          </label>
          <div className="form-actions">
            <button
              type="button"
              onClick={() =>
                update({ ...settings, agent: { endpoint: "", model: "", apiKey: "" } })
              }
            >
              Clear
            </button>
            <span className="field-hint">
              Keys typed here are held in <code>localStorage</code> and sent only to the
              endpoint above. Do not use a production key on a shared machine.
            </span>
          </div>
        </form>
      </section>

      <p className="settings-note">
        {BUILTIN_SOURCES.length} built-in sources ship with this prototype. Signals mean
        investigate; they do not diagnose disruption, evacuation or loss of access.
      </p>
    </div>
  );
}
