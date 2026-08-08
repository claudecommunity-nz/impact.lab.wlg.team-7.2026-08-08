/**
 * Browser-side clients for the model providers the chat can link to.
 *
 * Everything here runs in the visitor's browser with the visitor's own key:
 * the request goes straight from the browser to the provider host, the same
 * grounding context the local answerer uses rides along, and nothing touches
 * a server of ours. A provider failure throws — the caller falls back to the
 * local, artifact-grounded answer.
 */

import { type AgentConfig, AGENT_PROVIDERS } from "./data-sources";

const SYSTEM = [
  "You are the Murmur agent for Wellington City Council emergency management.",
  "Answer only from the operating-picture context provided; if it does not contain",
  "the answer, say so plainly. Signals mean investigate — never present one as a",
  "diagnosed incident, evacuation or loss of access. This is not live emergency",
  "information; in an emergency, call 111. Keep answers short and concrete.",
].join(" ");

/** True when the config is complete enough to route questions externally. */
export function agentIsConfigured(agent: AgentConfig): boolean {
  if (agent.provider === "none") return false;
  if (agent.provider === "custom") return agent.endpoint.trim().length > 0;
  return agent.apiKey.trim().length > 0;
}

/** Human-readable target, e.g. "Anthropic Claude · claude-opus-5". */
export function agentTarget(agent: AgentConfig): string {
  if (agent.provider === "custom") return `custom endpoint (${agent.endpoint})`;
  if (agent.provider === "none") return "local answers";
  const registry = AGENT_PROVIDERS[agent.provider];
  return `${registry.label} · ${agent.model.trim() || registry.defaultModel}`;
}

function modelFor(agent: AgentConfig): string {
  const typed = agent.model.trim();
  if (typed) return typed;
  if (agent.provider !== "none" && agent.provider !== "custom") {
    return AGENT_PROVIDERS[agent.provider].defaultModel;
  }
  return "";
}

/**
 * A blocked cross-origin request rejects with a bare `TypeError: Failed to
 * fetch` and no status, which tells an operator nothing. Name the two causes
 * they can actually act on.
 */
async function send(host: string, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new Error(
      `the browser could not reach ${host} — the provider may block direct browser calls (CORS), or you are offline`,
    );
  }
}

/** A typo'd endpoint should still name itself in the error, not throw again. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url || "the configured endpoint";
  }
}

async function readError(response: Response): Promise<string> {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string } | string;
      message?: string;
    };
    const inner =
      typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
    return inner ?? parsed.message ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status} ${response.statusText}`.trim();
  }
}

/**
 * `output_config.effort` is rejected by the older tiers — Haiku 4.5 is in the
 * model list and 400s on it — so only send it where it is supported, and omit
 * it for a model name we do not recognise.
 */
const EFFORT_MODELS = /^claude-(fable-5|mythos-5|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6)/;

async function askAnthropic(question: string, context: string, agent: AgentConfig) {
  const model = modelFor(agent);
  const response = await send("api.anthropic.com", "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": agent.apiKey.trim(),
      "anthropic-version": "2023-06-01",
      // Required for direct browser calls; the trade-off is the whole point
      // here — the visitor's key stays in the visitor's browser.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      // Thinking is on by default on current models and `max_tokens` caps
      // thinking *and* answer together, so a tight budget spends the whole
      // response on reasoning and returns no text at all. Low effort keeps a
      // grounded lookup snappy; the headroom keeps it from truncating.
      max_tokens: 16_000,
      ...(EFFORT_MODELS.test(model) ? { output_config: { effort: "low" } } : {}),
      system: `${SYSTEM}\n\n${context}`,
      messages: [{ role: "user", content: question }],
    }),
  });
  if (!response.ok) throw new Error(await readError(response));
  const body = (await response.json()) as {
    stop_reason?: string;
    content?: { type: string; text?: string }[];
  };
  if (body.stop_reason === "refusal") {
    return "The model declined this request for safety reasons. Ask about the published movement data instead.";
  }
  const text = (body.content ?? [])
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) {
    throw new Error(
      body.stop_reason === "max_tokens"
        ? "the answer hit the token ceiling before any text was written"
        : "the provider returned no text",
    );
  }
  return text;
}

/** OpenAI-compatible chat completions — used by OpenAI and DeepSeek. */
async function askChatCompletions(
  url: string,
  question: string,
  context: string,
  agent: AgentConfig,
) {
  const response = await send(new URL(url).host, url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${agent.apiKey.trim()}`,
    },
    body: JSON.stringify({
      model: modelFor(agent),
      messages: [
        { role: "system", content: `${SYSTEM}\n\n${context}` },
        { role: "user", content: question },
      ],
    }),
  });
  if (!response.ok) throw new Error(await readError(response));
  const body = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = body.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("The provider returned no text.");
  return text;
}

async function askGoogle(question: string, context: string, agent: AgentConfig) {
  const model = encodeURIComponent(modelFor(agent));
  const response = await send(
    "generativelanguage.googleapis.com",
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Header, not query param, so the key never lands in a URL log.
        "x-goog-api-key": agent.apiKey.trim(),
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: `${SYSTEM}\n\n${context}` }] },
        contents: [{ role: "user", parts: [{ text: question }] }],
      }),
    },
  );
  if (!response.ok) throw new Error(await readError(response));
  const body = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = (body.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("The provider returned no text.");
  return text;
}

/**
 * Custom endpoint: POST the question with the brief as context. The response
 * shape is deliberately forgiving — `reply`, `text`, `content`, `answer`, or
 * a plain-text body all work, so an operator can point this at their own
 * agent without writing an adapter.
 */
async function askCustom(question: string, context: unknown, agent: AgentConfig) {
  const endpoint = agent.endpoint.trim();
  const response = await send(safeHost(endpoint), endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(agent.apiKey ? { authorization: `Bearer ${agent.apiKey.trim()}` } : {}),
    },
    body: JSON.stringify({
      question,
      model: agent.model.trim() || undefined,
      context,
    }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const reply = parsed.reply ?? parsed.text ?? parsed.content ?? parsed.answer;
    return typeof reply === "string" ? reply : body;
  } catch {
    return body;
  }
}

/** Route one question to the configured provider. Throws on any failure. */
export async function askModel(
  question: string,
  context: unknown,
  agent: AgentConfig,
): Promise<string> {
  // Hosted providers take the brief as prompt text; a custom endpoint keeps the
  // structured object, so an operator's own agent can read fields rather than
  // re-parse a string.
  const text = typeof context === "string" ? context : JSON.stringify(context);
  switch (agent.provider) {
    case "anthropic":
      return askAnthropic(question, text, agent);
    case "openai":
      return askChatCompletions(
        "https://api.openai.com/v1/chat/completions",
        question,
        text,
        agent,
      );
    case "deepseek":
      return askChatCompletions(
        "https://api.deepseek.com/chat/completions",
        question,
        text,
        agent,
      );
    case "google":
      return askGoogle(question, text, agent);
    case "custom":
      return askCustom(question, context, agent);
    default:
      throw new Error("No provider configured.");
  }
}

/** Connectivity test for /settings — one tiny request, timed. */
export async function pingModel(agent: AgentConfig): Promise<string> {
  const startedAt = Date.now();
  const reply = await askModel(
    "Reply with the single word OK.",
    "This is a connectivity test; no operating-picture context is attached.",
    agent,
  );
  const clipped = reply.length > 60 ? `${reply.slice(0, 60)}…` : reply;
  return `${agentTarget(agent)} answered in ${Date.now() - startedAt} ms: “${clipped}”`;
}
