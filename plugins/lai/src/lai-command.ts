import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "openclaw/plugin-sdk/plugin-entry";

const execFileAsync = promisify(execFile);

type LaiCommandDeps = {
  exec?: typeof execFileAsync;
  resolveCommand?: (command: string) => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
  readFile?: typeof fs.readFile;
};

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
  const resolveCommand = deps.resolveCommand ?? ((command: string) => resolveCommandOnPath(command, env));
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

export function parseLaiArgs(raw: string): { ok: true; argv: string[] } | { ok: false; error: string } {
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

export function createLaiCommand(options: { deps?: LaiCommandDeps } = {}): OpenClawPluginCommandDefinition {
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
): Promise<{ text: string }> {
  const rawArgs = ctx.args?.trim() ?? "";
  if (!rawArgs) {
    return {
      text: [
        "Usage: /lai <subcommand...>",
        "",
        "Examples:",
        "- /lai codex usage --all",
        "- /lai codex accounts list",
        "- /lai codex accounts switch 2",
        "- /lai codex sync-auth 2",
      ].join("\n"),
    };
  }

  const env = await buildLaiRuntimeEnv(options.deps ?? {});
  const laiBinary = await resolveLaiBinary({
    env,
    resolveCommand: options.deps?.resolveCommand,
  });
  if (!laiBinary) {
    return {
      text: "lai is not available on PATH. Install lai or expose it in PATH before using /lai.",
    };
  }

  const parsed = parseLaiArgs(rawArgs);
  if (parsed.ok === false) {
    return { text: parsed.error };
  }

  const exec = options.deps?.exec ?? execFileAsync;
  const argv = parsed.argv;
  try {
    const { stdout, stderr } = await exec(laiBinary, argv, {
      encoding: "utf8",
      env,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
    return { text: output || `Ran: ${[laiBinary, ...argv].join(" ")}` };
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
      return { text: `/lai timed out (120s).${output ? `\n${output}` : ""}` };
    }
    const label = typeof err.code === "number" ? `exit ${err.code}` : err.code ?? "unknown error";
    return { text: `/lai failed (${label}).${output ? `\n${output}` : ""}` };
  }
}
