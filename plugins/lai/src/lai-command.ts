import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { InteractiveReply } from "openclaw/plugin-sdk/interactive-runtime";
import type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "openclaw/plugin-sdk/plugin-entry";

const execFileAsync = promisify(execFile);
const LAI_INTERACTIVE_NAMESPACE = "lai";

type LaiCodexAccount = {
  index: string;
  id: string;
  label: string;
  flags: string[];
};

type LaiCommandDeps = {
  exec?: typeof execFileAsync;
  resolveCommand?: (command: string) => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
  readFile?: typeof fs.readFile;
};

type LaiInteractiveActionResult =
  | {
      kind: "text";
      text: string;
    }
  | {
      kind: "menu";
      text: string;
      interactive: InteractiveReply;
    };

type TelegramButtons = Array<
  Array<{ text: string; callback_data: string; style?: "danger" | "success" | "primary" }>
>;

async function isExecutableFile(inputPath: string): Promise<boolean> {
  try {
    await fs.access(inputPath, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCommandOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const pathValue = env.PATH ?? "";
  const pathEntries = pathValue.split(path.delimiter).filter(Boolean);
  const windowsExts =
    process.platform === "win32"
      ? (env.PATHEXT?.split(";").filter(Boolean) ?? [".EXE", ".CMD", ".BAT"])
      : [""];

  if (command.includes(path.sep)) {
    return (await isExecutableFile(command)) ? command : null;
  }

  for (const dir of pathEntries) {
    for (const extension of windowsExts) {
      const candidate = path.join(dir, extension ? `${command}${extension}` : command);
      if (await isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

export async function resolveLaiBinary(
  deps: Pick<LaiCommandDeps, "resolveCommand" | "env"> = {},
): Promise<string | null> {
  const env = deps.env ?? process.env;
  const resolveCommand =
    deps.resolveCommand ?? ((command: string) => resolveCommandOnPath(command, env));
  const localPath = path.join(env.HOME ?? os.homedir(), ".local", "bin", "lai");
  if (await isExecutableFile(localPath)) {
    return localPath;
  }
  return await resolveCommand("lai");
}

export async function buildLaiRuntimeEnv(
  deps: Pick<LaiCommandDeps, "env" | "readFile"> = {},
): Promise<NodeJS.ProcessEnv> {
  const env = { ...(deps.env ?? process.env) };
  const home = env.HOME ?? os.homedir();
  const nvmDir = env.NVM_DIR ?? path.join(home, ".nvm");
  env.NVM_DIR = nvmDir;
  const readFile = deps.readFile ?? fs.readFile;

  const candidates: string[] = [];
  try {
    const version = (await readFile(path.join(nvmDir, "alias", "default"), "utf8")).trim();
    if (version) {
      candidates.push(path.join(nvmDir, "versions", "node", version, "bin"));
    }
  } catch {
    // Ignore missing nvm default alias.
  }

  if (env.NVM_BIN?.trim()) {
    candidates.push(env.NVM_BIN.trim());
  }

  const existing = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const part of [...candidates, ...existing]) {
    if (!part || seen.has(part)) {
      continue;
    }
    seen.add(part);
    merged.push(part);
  }
  env.PATH = merged.join(path.delimiter);
  return env;
}

export function parseLaiArgs(
  raw: string,
): { ok: true; argv: string[] } | { ok: false; error: string } {
  const tokens: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  const pushToken = () => {
    if (buf.length > 0) {
      tokens.push(buf);
      buf = "";
    }
  };

  for (const ch of raw) {
    if (escaping) {
      buf += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        buf += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      pushToken();
      continue;
    }
    buf += ch;
  }

  if (escaping) {
    buf += "\\";
  }
  if (quote) {
    return { ok: false, error: "/lai argument parse error: unmatched quote" };
  }
  pushToken();
  if (tokens.length == 0) {
    return { ok: false, error: "Usage: /lai <subcommand...>" };
  }
  return { ok: true, argv: tokens };
}

export function parseCodexAccountsList(output: string): LaiCodexAccount[] {
  const accounts: LaiCodexAccount[] = [];

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const tabParts = line
      .split(/\t+/)
      .map((part) => part.trim())
      .filter(Boolean);
    const parts =
      tabParts.length >= 3
        ? tabParts
        : line
            .split(/\s{2,}/)
            .map((part) => part.trim())
            .filter(Boolean);
    if (parts.length < 3) {
      continue;
    }

    const [index, id, ...rest] = parts;
    if (!/^\d+$/.test(index) || !id) {
      continue;
    }

    const detail = rest.join(" ").trim();
    const flags = Array.from(detail.matchAll(/\[([^\]]+)\]/g))
      .flatMap((match) => match[1].split(/\s+/))
      .map((flag) => flag.trim())
      .filter(Boolean);
    const label = detail.replace(/\s*\[[^\]]+\]\s*$/g, "").trim() || id;

    accounts.push({
      index,
      id,
      label,
      flags,
    });
  }

  return accounts;
}

export function parseLaiInteractivePayload(
  payload: string,
):
  | { action: "usage-all" }
  | { action: "open-switch" }
  | { action: "switch-account"; account: string }
  | { error: string } {
  const trimmed = payload.trim();
  if (trimmed === "usage-all") {
    return { action: "usage-all" };
  }
  if (trimmed === "open-switch") {
    return { action: "open-switch" };
  }
  if (trimmed.startsWith("switch-account:")) {
    const account = trimmed.slice("switch-account:".length).trim();
    if (!account) {
      return { error: "Missing account id for lai codex accounts switch." };
    }
    return { action: "switch-account", account };
  }
  return { error: `Unknown lai menu action: ${payload}` };
}

export function createLaiCommand(
  options: { deps?: LaiCommandDeps } = {},
): OpenClawPluginCommandDefinition {
  return {
    name: "lai",
    description: "Run lai directly without LLM interpretation",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => await handleLaiCommand(ctx, options),
  };
}

export async function handleLaiCommand(
  ctx: PluginCommandContext,
  options: { deps?: LaiCommandDeps } = {},
): Promise<{ text: string; interactive?: InteractiveReply }> {
  const rawArgs = ctx.args?.trim() ?? "";
  if (!rawArgs) {
    return buildLaiRootMenuReply();
  }

  const parsed = parseLaiArgs(rawArgs);
  if (!parsed.ok) {
    return { text: parsed.error };
  }

  return { text: await runLaiCommand(parsed.argv, options.deps ?? {}) };
}

export function registerLaiInteractiveHandlers(
  api: OpenClawPluginApi,
  options: { deps?: LaiCommandDeps } = {},
): void {
  api.registerInteractiveHandler({
    channel: "telegram",
    namespace: LAI_INTERACTIVE_NAMESPACE,
    handler: async (ctx: unknown) => {
      const typedCtx = ctx as {
        auth: { isAuthorizedSender: boolean };
        callback: { payload: string };
        respond: {
          reply: (params: { text: string; buttons?: TelegramButtons }) => Promise<void>;
          editMessage: (params: { text: string; buttons?: TelegramButtons }) => Promise<void>;
        };
      };
      const result = await handleLaiInteractiveAction(
        typedCtx.auth.isAuthorizedSender,
        typedCtx.callback.payload,
        options,
      );
      if (result.kind === "menu") {
        await typedCtx.respond.editMessage({
          text: result.text,
          buttons: buildTelegramButtons(result.interactive),
        });
      } else {
        await typedCtx.respond.reply({ text: result.text });
      }
      return { handled: true };
    },
  });

  api.registerInteractiveHandler({
    channel: "discord",
    namespace: LAI_INTERACTIVE_NAMESPACE,
    handler: async (ctx: unknown) => {
      const typedCtx = ctx as {
        auth: { isAuthorizedSender: boolean };
        interaction: { payload: string };
        respond: {
          reply: (params: { text: string; ephemeral?: boolean }) => Promise<void>;
          clearComponents: (params?: { text?: string }) => Promise<void>;
        };
      };
      const result = await handleLaiInteractiveAction(
        typedCtx.auth.isAuthorizedSender,
        typedCtx.interaction.payload,
        options,
      );
      if (result.kind === "menu") {
        await typedCtx.respond.clearComponents({ text: result.text });
      } else {
        await typedCtx.respond.reply({
          text: result.text,
          ephemeral: true,
        });
      }
      return { handled: true };
    },
  });

  api.registerInteractiveHandler({
    channel: "slack",
    namespace: LAI_INTERACTIVE_NAMESPACE,
    handler: async (ctx: unknown) => {
      const typedCtx = ctx as {
        auth: { isAuthorizedSender: boolean };
        interaction: { payload: string };
        respond: {
          reply: (params: {
            text: string;
            responseType?: "ephemeral" | "in_channel";
          }) => Promise<void>;
          editMessage: (params: { text?: string; blocks?: unknown[] }) => Promise<void>;
        };
      };
      const result = await handleLaiInteractiveAction(
        typedCtx.auth.isAuthorizedSender,
        typedCtx.interaction.payload,
        options,
      );
      if (result.kind === "menu") {
        await typedCtx.respond.editMessage({
          text: result.text,
          blocks: buildSlackBlocks(result.interactive),
        });
      } else {
        await typedCtx.respond.reply({
          text: result.text,
          responseType: "ephemeral",
        });
      }
      return { handled: true };
    },
  });
}

function buildLaiRootMenuReply(): { text: string; interactive: InteractiveReply } {
  return {
    text: ["LAI Codex menu", "", "Choose an action:", "- Codex Usage --all", "- Codex Switch"].join(
      "\n",
    ),
    interactive: {
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Codex Usage --all",
              value: `${LAI_INTERACTIVE_NAMESPACE}:usage-all`,
              style: "primary",
            },
            {
              label: "Codex Switch",
              value: `${LAI_INTERACTIVE_NAMESPACE}:open-switch`,
            },
          ],
        },
      ],
    },
  };
}

async function buildLaiSwitchMenuReply(deps: LaiCommandDeps): Promise<LaiInteractiveActionResult> {
  const listResult = await runLaiCommand(["codex", "accounts", "list"], deps);
  if (isLaiCommandFailureText(listResult)) {
    return { kind: "text", text: listResult };
  }

  const accounts = parseCodexAccountsList(listResult);
  if (accounts.length === 0) {
    return {
      kind: "text",
      text: "No managed Codex accounts were found.",
    };
  }

  return {
    kind: "menu",
    text: buildLaiAccountMenuText(accounts),
    interactive: {
      blocks: [
        {
          type: "buttons",
          buttons: accounts.map((account) => ({
            label: formatMenuAccountOption(account),
            value: `${LAI_INTERACTIVE_NAMESPACE}:switch-account:${account.id}`,
            style: account.flags.includes("active") ? "primary" : undefined,
          })),
        },
      ],
    },
  };
}

function buildLaiAccountMenuText(accounts: LaiCodexAccount[]): string {
  return [
    "Choose a Codex account.",
    "",
    ...accounts.map((account) => `- ${formatMenuAccountText(account)} (${account.id})`),
  ].join("\n");
}

function buildTelegramButtons(interactive: InteractiveReply): TelegramButtons | undefined {
  const rows: TelegramButtons = [];
  for (const block of interactive.blocks) {
    if (block.type !== "buttons") {
      continue;
    }
    for (let index = 0; index < block.buttons.length; index += 3) {
      const row = block.buttons.slice(index, index + 3).map((button) => ({
        text: button.label,
        callback_data: button.value,
        style:
          button.style === "danger" || button.style === "success" || button.style === "primary"
            ? button.style
            : undefined,
      }));
      if (row.length > 0) {
        rows.push(row);
      }
    }
  }
  return rows.length > 0 ? rows : undefined;
}

function buildSlackBlocks(interactive: InteractiveReply): unknown[] | undefined {
  const blocks: unknown[] = [];
  let blockIndex = 0;
  for (const block of interactive.blocks) {
    if (block.type !== "buttons" || block.buttons.length === 0) {
      continue;
    }
    blockIndex += 1;
    blocks.push({
      type: "actions",
      block_id: `lai_buttons_${String(blockIndex)}`,
      elements: block.buttons.map((button, choiceIndex) =>
        Object.assign(
          {
            type: `button`,
            action_id: `lai_button_${String(blockIndex)}_${String(choiceIndex + 1)}`,
            text: { type: `plain_text`, text: truncateLabel(button.label, 75), emoji: true },
            value: button.value,
          },
          button.style === `primary` || button.style === `danger` ? { style: button.style } : {},
        ),
      ),
    });
  }
  return blocks.length > 0 ? blocks : undefined;
}

function formatMenuAccountOption(account: LaiCodexAccount): string {
  return truncateLabel(formatMenuAccountText(account), 75);
}

function formatMenuAccountText(account: LaiCodexAccount): string {
  const flags = account.flags.length > 0 ? ` [${account.flags.join(" ")}]` : "";
  return `#${account.index} ${account.label}${flags}`;
}

function truncateLabel(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function isLaiCommandFailureText(text: string): boolean {
  return (
    text.startsWith("lai is not available on PATH.") ||
    text.startsWith("/lai timed out") ||
    text.startsWith("/lai failed")
  );
}

async function switchCodexAccountAndSync(
  account: string,
  deps: LaiCommandDeps,
): Promise<LaiInteractiveActionResult> {
  const switchResult = await runLaiCommand(["codex", "accounts", "switch", account], deps);
  if (isLaiCommandFailureText(switchResult)) {
    return { kind: "text", text: switchResult };
  }

  const syncResult = await runLaiCommand(["codex", "sync-auth", account], deps);
  if (isLaiCommandFailureText(syncResult)) {
    return {
      kind: "text",
      text: [`Codex account switched to ${account}.`, "", syncResult].join("\n"),
    };
  }

  return {
    kind: "text",
    text: [
      `Codex account switched and synced: ${account}`,
      "",
      "$ lai codex accounts switch",
      switchResult,
      "",
      "$ lai codex sync-auth",
      syncResult,
    ].join("\n"),
  };
}

export async function handleLaiInteractiveAction(
  isAuthorizedSender: boolean,
  payload: string,
  options: { deps?: LaiCommandDeps } = {},
): Promise<LaiInteractiveActionResult> {
  if (!isAuthorizedSender) {
    return { kind: "text", text: "⚠️ This command requires authorization." };
  }

  const parsed = parseLaiInteractivePayload(payload);
  if ("error" in parsed) {
    return { kind: "text", text: parsed.error };
  }

  if (parsed.action === "usage-all") {
    return {
      kind: "text",
      text: await runLaiCommand(["codex", "usage", "--all"], options.deps ?? {}),
    };
  }
  if (parsed.action === "open-switch") {
    return await buildLaiSwitchMenuReply(options.deps ?? {});
  }
  return await switchCodexAccountAndSync(parsed.account, options.deps ?? {});
}

async function runLaiCommand(argv: string[], deps: LaiCommandDeps): Promise<string> {
  const env = await buildLaiRuntimeEnv(deps);
  const laiBinary = await resolveLaiBinary({
    env,
    resolveCommand: deps.resolveCommand,
  });
  if (!laiBinary) {
    return "lai is not available on PATH. Install lai or expose it in PATH before using /lai.";
  }

  return await runLaiCommandWithRuntime(laiBinary, argv, env, deps);
}

async function runLaiCommandWithRuntime(
  laiBinary: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
  deps: LaiCommandDeps,
): Promise<string> {
  const exec = deps.exec ?? execFileAsync;
  try {
    const { stdout, stderr } = await exec(laiBinary, argv, {
      encoding: "utf8",
      env,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
    return output || `Ran: ${[laiBinary, ...argv].join(" ")}`;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
      signal?: string;
      killed?: boolean;
    };
    const output = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
    if (err.killed || err.signal === "SIGTERM") {
      return `/lai timed out (120s).${output ? `\n${output}` : ""}`;
    }
    const label =
      typeof err.code === "number"
        ? `exit ${String(err.code)}`
        : typeof err.code === "string"
          ? err.code
          : "unknown error";
    return `/lai failed (${label}).${output ? `\n${output}` : ""}`;
  }
}
