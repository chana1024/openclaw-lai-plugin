import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const PROVIDER_ID = "newapi-codex";
const API_ID = "openai-codex-responses";
const DEFAULT_BASE_URL = "http://127.0.0.1:3000/v1";
const MODEL_IDS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"];

type AnyRecord = Record<string, any>;

class AssistantStream implements AsyncIterable<AnyRecord> {
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

function resolveApiKey(model: AnyRecord, options: AnyRecord | undefined, pluginConfig: AnyRecord): string {
  const value = options?.apiKey ?? model.apiKey ?? pluginConfig.apiKey;
  return typeof value === "string" ? value.trim() : "";
}

function createOutput(model: AnyRecord): AnyRecord {
  return {
    role: "assistant",
    content: [],
    api: API_ID,
    provider: model.provider,
    model: model.id,
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
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const part = item as AnyRecord;
      return part.type === "text" && typeof part.text === "string" ? part.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function convertInput(model: AnyRecord, context: AnyRecord): AnyRecord[] {
  const input: AnyRecord[] = [];
  for (const message of context.messages ?? []) {
    if (!message || typeof message !== "object") continue;
    const msg = message as AnyRecord;
    if (msg.role === "user") {
      const content = Array.isArray(msg.content)
        ? msg.content.flatMap((item: AnyRecord) => {
            if (item?.type === "text" && typeof item.text === "string") {
              return [{ type: "input_text", text: item.text }];
            }
            if (item?.type === "image" && model.input?.includes("image") && item.mimeType && item.data) {
              return [{ type: "input_image", detail: "auto", image_url: `data:${item.mimeType};base64,${item.data}` }];
            }
            return [];
          })
        : [{ type: "input_text", text: String(msg.content ?? "") }];
      if (content.length > 0) input.push({ role: "user", content });
    } else if (msg.role === "assistant") {
      for (const block of msg.content ?? []) {
        if (block?.type === "text" && typeof block.text === "string") {
          input.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: block.text, annotations: [] }],
            status: "completed",
          });
        } else if (block?.type === "toolCall") {
          const [callId, itemId] = String(block.id ?? "").split("|");
          input.push({
            type: "function_call",
            id: itemId || undefined,
            call_id: callId || String(block.id ?? ""),
            name: block.name,
            arguments: JSON.stringify(block.arguments ?? {}),
          });
        }
      }
    } else if (msg.role === "toolResult") {
      const [callId] = String(msg.toolCallId ?? "").split("|");
      input.push({
        type: "function_call_output",
        call_id: callId || String(msg.toolCallId ?? ""),
        output: textOfContent(msg.content),
      });
    }
  }
  return input;
}

function buildBody(model: AnyRecord, context: AnyRecord, options: AnyRecord | undefined): AnyRecord {
  const body: AnyRecord = {
    model: model.id,
    store: false,
    stream: true,
    instructions: context.systemPrompt || "You are a helpful assistant.",
    input: convertInput(model, context),
    text: { verbosity: options?.textVerbosity || "medium" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: options?.sessionId,
    tool_choice: "auto",
    parallel_tool_calls: true,
  };
  if (options?.temperature !== undefined) body.temperature = options.temperature;
  if (options?.reasoning !== undefined) {
    body.reasoning = { effort: options.reasoning === "minimal" ? "low" : options.reasoning, summary: "auto" };
  }
  if (Array.isArray(context.tools) && context.tools.length > 0) {
    body.tools = context.tools.map((tool: AnyRecord) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: null,
    }));
  }
  return body;
}

async function* parseSse(response: Response): AsyncGenerator<AnyRecord> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n")
        .trim();
      if (data && data !== "[DONE]") {
        try {
          yield JSON.parse(data);
        } catch {
          // Ignore malformed keepalive chunks.
        }
      }
      index = buffer.indexOf("\n\n");
    }
  }
}

async function parseError(response: Response): Promise<string> {
  const raw = await response.text();
  try {
    const parsed = JSON.parse(raw);
    return parsed?.error?.message || raw || response.statusText;
  } catch {
    return raw || response.statusText;
  }
}

function pushText(stream: AssistantStream, output: AnyRecord, text: string) {
  if (!text) return;
  let block = output.content[output.content.length - 1];
  if (!block || block.type !== "text") {
    block = { type: "text", text: "" };
    output.content.push(block);
    stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
  }
  block.text += text;
  stream.push({ type: "text_delta", contentIndex: output.content.length - 1, delta: text, partial: output });
}

function finishText(stream: AssistantStream, output: AnyRecord) {
  const index = output.content.length - 1;
  const block = output.content[index];
  if (block?.type === "text") {
    stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
  }
}

function mapUsage(response: AnyRecord, output: AnyRecord) {
  const usage = response?.usage;
  if (!usage) return;
  const cached = usage.input_tokens_details?.cached_tokens || 0;
  output.usage.input = (usage.input_tokens || 0) - cached;
  output.usage.output = usage.output_tokens || 0;
  output.usage.cacheRead = cached;
  output.usage.totalTokens = usage.total_tokens || output.usage.input + output.usage.output + cached;
}

function createStreamFn(pluginConfig: AnyRecord, runtimeContext?: AnyRecord) {
  return (model: AnyRecord, context: AnyRecord, options?: AnyRecord) => {
    const runtimeModel = runtimeContext?.model ?? {};
    const effectiveModel = {
      ...runtimeModel,
      ...model,
      id: model?.id ?? runtimeContext?.modelId ?? runtimeModel?.id ?? "gpt-5.4",
      provider: model?.provider ?? runtimeContext?.provider ?? runtimeModel?.provider ?? PROVIDER_ID,
      baseUrl: model?.baseUrl ?? runtimeModel?.baseUrl ?? pluginConfig.baseUrl,
      apiKey: model?.apiKey ?? runtimeModel?.apiKey ?? pluginConfig.apiKey,
    };
    const stream = new AssistantStream();
    const output = createOutput(effectiveModel);
    queueMicrotask(async () => {
      try {
        const apiKey = resolveApiKey(effectiveModel, options, pluginConfig);
        if (!apiKey) throw new Error("No API key for provider: newapi-codex");
        const response = await fetch(`${normalizeBaseUrl(effectiveModel.baseUrl ?? pluginConfig.baseUrl)}/responses`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            accept: "text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify(buildBody(effectiveModel, context, options)),
          signal: options?.signal,
        });
        if (!response.ok) throw new Error(await parseError(response));
        stream.push({ type: "start", partial: output });
        for await (const event of parseSse(response)) {
          if (event.type === "response.created" && event.response?.id) output.responseId = event.response.id;
          else if (event.type === "response.output_text.delta") pushText(stream, output, event.delta || "");
          else if (event.type === "response.output_item.done" && event.item?.type === "message") {
            const text = (event.item.content ?? []).map((part: AnyRecord) => part.text || part.refusal || "").join("");
            const block = output.content[output.content.length - 1];
            if (block?.type === "text" && text) block.text = text;
            finishText(stream, output);
          } else if (event.type === "response.completed") {
            if (event.response?.id) output.responseId = event.response.id;
            mapUsage(event.response, output);
            output.stopReason = output.content.some((block: AnyRecord) => block.type === "toolCall") ? "toolUse" : "stop";
          } else if (event.type === "response.failed") {
            throw new Error(event.response?.error?.message || "new-api response failed");
          } else if (event.type === "error") {
            throw new Error(event.message || event.code || "new-api stream error");
          }
        }
        stream.push({ type: "done", reason: output.stopReason, message: output });
        stream.end();
      } catch (error) {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
      }
    });
    return stream;
  };
}

function buildProvider(config: AnyRecord, apiKey: string) {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  return {
    baseUrl,
    apiKey,
    api: API_ID,
    models: MODEL_IDS.map((id) => ({
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
    })),
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
      resolveDynamicModel: (ctx: AnyRecord) => {
        const id = String(ctx.modelId || "gpt-5.4");
        return buildProvider(pluginConfig, pluginConfig.apiKey || "configured-by-runtime").models.find((model) => model.id === id) ??
          buildProvider(pluginConfig, pluginConfig.apiKey || "configured-by-runtime").models[1];
      },
      createStreamFn: () => createStreamFn(pluginConfig),
      wrapStreamFn: (ctx: AnyRecord) => createStreamFn(pluginConfig, ctx),
      isModernModelRef: () => true,
      resolveReasoningOutputMode: () => "native",
    });
  },
});
