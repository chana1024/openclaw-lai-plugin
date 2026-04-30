import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const PROVIDER_ID = "newapi-codex";
const API_ID = "openai-codex-responses";
const DEFAULT_BASE_URL = "http://127.0.0.1:3000/v1";
const MODEL_IDS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"];
const XHIGH_MODEL_IDS = new Set(["gpt-5.5", "gpt-5.4", "gpt-5.3-codex"]);
const MODERN_MODEL_IDS = new Set(MODEL_IDS);

type AnyRecord = Record<string, any>;

const openClawPluginEntryUrl = import.meta.resolve("openclaw/plugin-sdk/plugin-entry");
const openAIResponsesSharedUrl = new URL(
  "../../node_modules/@mariozechner/pi-ai/dist/providers/openai-responses-shared.js",
  openClawPluginEntryUrl,
).href;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const CODEX_RESPONSE_STATUSES = new Set(["completed", "incomplete", "failed", "cancelled", "queued", "in_progress"]);

class ForwardingStream implements AsyncIterable<AnyRecord> {
  private queue: AnyRecord[] = [];
  private waiters: Array<(value: IteratorResult<AnyRecord>) => void> = [];
  private done = false;
  private resolveFinalResult!: (value: AnyRecord) => void;
  private finalResultPromise: Promise<AnyRecord>;

  constructor() {
    this.finalResultPromise = new Promise((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }

  push(event: AnyRecord) {
    if (this.done) return;
    if (event.type === "done" || event.type === "error") {
      this.done = true;
      this.resolveFinalResult(event.type === "done" ? event.message : event.error);
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }

  end() {
    this.done = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.queue.length > 0) yield this.queue.shift();
      else if (this.done) return;
      else {
        const result = await new Promise<IteratorResult<AnyRecord>>((resolve) => this.waiters.push(resolve));
        if (result.done) return;
        yield result.value;
      }
    }
  }

  result() {
    return this.finalResultPromise;
  }
}

function normalizeBaseUrl(raw: unknown): string {
  const value = typeof raw === "string" && raw.trim() ? raw.trim() : DEFAULT_BASE_URL;
  return value.replace(/\/+$/, "");
}

function resolveApiKey(pluginConfig: AnyRecord, apiKey?: string): string {
  const value = apiKey ?? pluginConfig.apiKey ?? process.env.NEWAPI_CODEX_API_KEY;
  return typeof value === "string" ? value.trim() : "";
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Request was aborted"));
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new Error("Request was aborted"));
      },
      { once: true },
    );
  });
}

function isRetryableError(status: number, errorText: string): boolean {
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(errorText);
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

async function parseErrorResponse(response: Response): Promise<string> {
  const raw = await response.text();
  try {
    const parsed = JSON.parse(raw);
    return parsed?.error?.message || parsed?.message || raw || response.statusText || "Request failed";
  } catch {
    return raw || response.statusText || "Request failed";
  }
}

function buildModels(baseUrl: string) {
  return MODEL_IDS.map((id) => ({
    id,
    name: `${id} (new-api Codex)`,
    api: API_ID,
    provider: PROVIDER_ID,
    baseUrl,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: id === "gpt-5.4" ? 1050000 : 400000,
    contextTokens: id === "gpt-5.4" ? 272000 : undefined,
    maxTokens: 128000,
  }));
}

function buildProvider(config: AnyRecord, apiKey?: string) {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  return {
    baseUrl,
    apiKey: resolveApiKey(config, apiKey),
    api: API_ID,
    models: buildModels(baseUrl),
  };
}

function resolveDynamicModel(config: AnyRecord, modelId: string) {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const id = modelId.trim() || "gpt-5.4";
  return (
    buildModels(baseUrl).find((model) => model.id === id) ?? {
      id,
      name: `${id} (new-api Codex)`,
      api: API_ID,
      provider: PROVIDER_ID,
      baseUrl,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 400000,
      maxTokens: 128000,
    }
  );
}

function resolveResponsesUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized.endsWith("/responses")) return normalized;
  return `${normalized}/responses`;
}

function clampReasoningEffort(modelId: string, effort: string) {
  const id = modelId.includes("/") ? modelId.split("/").pop()! : modelId;
  if (
    (id.startsWith("gpt-5.2") || id.startsWith("gpt-5.3") || id.startsWith("gpt-5.4") || id.startsWith("gpt-5.5")) &&
    effort === "minimal"
  ) {
    return "low";
  }
  if (id === "gpt-5.1" && effort === "xhigh") return "high";
  if (id === "gpt-5.1-codex-mini") return effort === "high" || effort === "xhigh" ? "high" : "medium";
  return effort;
}

async function buildRequestBody(model: AnyRecord, context: AnyRecord, options: AnyRecord | undefined): Promise<AnyRecord> {
  const { convertResponsesMessages, convertResponsesTools } = (await import(openAIResponsesSharedUrl)) as AnyRecord;
  const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
    includeSystemPrompt: false,
  });
  const body: AnyRecord = {
    model: model.id,
    store: false,
    stream: true,
    instructions: context.systemPrompt,
    input: messages,
    text: { verbosity: options?.textVerbosity || "low" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: options?.sessionId,
    tool_choice: "auto",
    parallel_tool_calls: true,
  };
  if (options?.maxTokens) body.max_output_tokens = options.maxTokens;
  if (options?.temperature !== undefined) body.temperature = options.temperature;
  if (options?.serviceTier !== undefined) body.service_tier = options.serviceTier;
  if (context.tools && context.tools.length > 0) body.tools = convertResponsesTools(context.tools, { strict: null });
  if (options?.reasoningEffort !== undefined) {
    body.reasoning = {
      effort: clampReasoningEffort(String(model.id), options.reasoningEffort),
      summary: options.reasoningSummary ?? "auto",
    };
  }
  return body;
}

async function* parseSSE(response: Response): AsyncGenerator<AnyRecord> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLines = chunk
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());
        if (dataLines.length > 0) {
          const data = dataLines.join("\n").trim();
          if (data && data !== "[DONE]") {
            try {
              yield JSON.parse(data);
            } catch {
              // Ignore malformed SSE fragments; upstream stream errors are emitted as events.
            }
          }
        }
        idx = buffer.indexOf("\n\n");
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
    try {
      reader.releaseLock();
    } catch {}
  }
}

function normalizeCodexStatus(status: unknown) {
  if (typeof status !== "string") return undefined;
  return CODEX_RESPONSE_STATUSES.has(status) ? status : undefined;
}

async function* mapCodexEvents(events: AsyncIterable<AnyRecord>): AsyncGenerator<AnyRecord> {
  for await (const event of events) {
    const type = typeof event.type === "string" ? event.type : undefined;
    if (!type) continue;
    if (type === "error") {
      const code = event.code || "";
      const message = event.message || "";
      throw new Error(`Codex error: ${message || code || JSON.stringify(event)}`);
    }
    if (type === "response.failed") {
      const msg = event.response?.error?.message;
      throw new Error(msg || "Codex response failed");
    }
    if (type === "response.done" || type === "response.completed" || type === "response.incomplete") {
      const response = event.response;
      const normalizedResponse = response ? { ...response, status: normalizeCodexStatus(response.status) } : response;
      yield { ...event, type: "response.completed", response: normalizedResponse };
      return;
    }
    yield event;
  }
}

async function processStream(response: Response, output: AnyRecord, stream: ForwardingStream, model: AnyRecord) {
  const { processResponsesStream } = (await import(openAIResponsesSharedUrl)) as AnyRecord;
  await processResponsesStream(mapCodexEvents(parseSSE(response)), output, stream, model);
}

function createNewApiCodexStreamFn(pluginConfig: AnyRecord) {
  return (model: AnyRecord, context: AnyRecord, options?: AnyRecord) => {
    const stream = new ForwardingStream();
    const nextContext = {
      ...context,
      systemPrompt: context?.systemPrompt || "You are a helpful assistant.",
    };
    queueMicrotask(async () => {
      const output = {
        role: "assistant",
        content: [],
        api: API_ID,
        provider: PROVIDER_ID,
        model: model?.id ?? "gpt-5.4",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      try {
        const requestModel = {
          ...model,
          api: API_ID,
          provider: PROVIDER_ID,
          baseUrl: normalizeBaseUrl(model?.baseUrl ?? pluginConfig.baseUrl),
        };
        const apiKey = resolveApiKey(pluginConfig, options?.apiKey);
        if (!apiKey) throw new Error(`No API key for provider: ${PROVIDER_ID}`);
        let body = await buildRequestBody(requestModel, nextContext, options);
        const nextBody = await options?.onPayload?.(body, requestModel);
        if (nextBody !== undefined) body = nextBody;
        const headers = new Headers({
          ...(requestModel.headers || {}),
          ...(options?.headers || {}),
          Authorization: `Bearer ${apiKey}`,
          Accept: "text/event-stream",
          "Content-Type": "application/json",
        });
        if (options?.sessionId) {
          headers.set("session_id", options.sessionId);
          headers.set("x-client-request-id", options.sessionId);
        }
        const bodyJson = JSON.stringify(body);
        let response: Response | undefined;
        let lastError: Error | undefined;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          if (options?.signal?.aborted) throw new Error("Request was aborted");
          try {
            response = await fetch(resolveResponsesUrl(requestModel.baseUrl), {
              method: "POST",
              headers,
              body: bodyJson,
              signal: options?.signal,
            });
            await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, requestModel);
            if (response.ok) break;
            const errorText = await response.text();
            if (attempt < MAX_RETRIES && isRetryableError(response.status, errorText)) {
              await sleep(BASE_DELAY_MS * 2 ** attempt, options?.signal);
              continue;
            }
            throw new Error(await parseErrorResponse(new Response(errorText, { status: response.status, statusText: response.statusText })));
          } catch (error) {
            if (error instanceof Error && (error.name === "AbortError" || error.message === "Request was aborted")) {
              throw new Error("Request was aborted");
            }
            lastError = error instanceof Error ? error : new Error(String(error));
            if (attempt < MAX_RETRIES && !lastError.message.includes("usage limit")) {
              await sleep(BASE_DELAY_MS * 2 ** attempt, options?.signal);
              continue;
            }
            throw lastError;
          }
        }
        if (!response?.ok) throw lastError ?? new Error("Failed after retries");
        if (!response.body) throw new Error("No response body");
        stream.push({ type: "start", partial: output });
        await processStream(response, output, stream, requestModel);
        if (options?.signal?.aborted) throw new Error("Request was aborted");
        stream.push({ type: "done", reason: output.stopReason, message: output });
        stream.end();
      } catch (error) {
        for (const block of output.content) delete block.partialJson;
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        (output as AnyRecord).errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
      }
    });
    return stream;
  };
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "New API Codex Provider",
  description: "Routes OpenClaw model calls to a local new-api Codex Responses endpoint.",
  register(api) {
    const pluginConfig = (api.pluginConfig ?? {}) as AnyRecord;
    api.registerProvider({
      id: PROVIDER_ID,
      label: "new-api Codex",
      envVars: ["NEWAPI_CODEX_API_KEY"],
      catalog: {
        order: "simple",
        run: async (ctx: AnyRecord) => {
          const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey || pluginConfig.apiKey;
          if (!apiKey) return null;
          return { provider: buildProvider(pluginConfig, apiKey) };
        },
      },
      resolveDynamicModel: (ctx: AnyRecord) => resolveDynamicModel(pluginConfig, String(ctx.modelId || "gpt-5.4")),
      normalizeResolvedModel: (ctx: AnyRecord) => {
        if (ctx.provider !== PROVIDER_ID) return;
        return {
          ...ctx.model,
          api: API_ID,
          provider: PROVIDER_ID,
          baseUrl: normalizeBaseUrl(ctx.model?.baseUrl ?? pluginConfig.baseUrl),
        };
      },
      normalizeTransport: ({ provider, api, baseUrl }: AnyRecord) => {
        if (provider !== PROVIDER_ID) return;
        if (api === API_ID && baseUrl === normalizeBaseUrl(baseUrl ?? pluginConfig.baseUrl)) return;
        return { api: API_ID, baseUrl: normalizeBaseUrl(baseUrl ?? pluginConfig.baseUrl) };
      },
      createStreamFn: () => createNewApiCodexStreamFn(pluginConfig),
      resolveReasoningOutputMode: () => "native",
      resolveThinkingProfile: ({ modelId }: AnyRecord) => ({
        levels: [
          { id: "off" },
          { id: "minimal" },
          { id: "low" },
          { id: "medium" },
          { id: "high" },
          ...(XHIGH_MODEL_IDS.has(String(modelId || "").trim()) ? [{ id: "xhigh" }] : []),
        ],
      }),
      isModernModelRef: ({ modelId }: AnyRecord) => MODERN_MODEL_IDS.has(String(modelId || "").trim()),
    });
  },
});
