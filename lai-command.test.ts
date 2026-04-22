import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import {
  createLaiCommand,
  handleLaiCommand,
  handleLaiInteractiveAction,
  parseCodexAccountsList,
  parseLaiArgs,
  parseLaiInteractivePayload,
} from "./src/lai-command.js";

function createContext(args?: string): PluginCommandContext {
  return {
    channel: "telegram",
    isAuthorizedSender: true,
    commandBody: args ? `/lai ${args}` : "/lai",
    args,
  } as PluginCommandContext;
}

function createDeps(
  exec?: (cmd: string, argv: string[]) => Promise<{ stdout: string; stderr: string }>,
) {
  return {
    exec: (exec ?? (async () => ({ stdout: "", stderr: "" }))) as never,
    resolveCommand: async () => "/usr/bin/lai",
    env: { PATH: "/usr/bin", HOME: "/home/test" },
    readFile: vi.fn(async () => "v24.13.0\n") as never,
  };
}

describe("lai command", () => {
  it("registers as an authorized slash command with args", () => {
    expect(createLaiCommand()).toMatchObject({
      name: "lai",
      acceptsArgs: true,
      requireAuth: true,
    });
  });

  it("returns a two-button root menu when no args are provided", async () => {
    await expect(handleLaiCommand(createContext())).resolves.toMatchObject({
      text: expect.stringContaining("LAI Codex menu"),
      interactive: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Codex Usage --all",
                value: "lai:usage-all",
                style: "primary",
              },
              {
                label: "Codex Switch",
                value: "lai:open-switch",
              },
            ],
          },
        ],
      },
    });
  });

  it("parses quoted lai args", () => {
    expect(parseLaiArgs('codex run --prompt "hello world"')).toEqual({
      ok: true,
      argv: ["codex", "run", "--prompt", "hello world"],
    });
  });

  it("surfaces unmatched quote errors", async () => {
    await expect(handleLaiCommand(createContext('codex run "oops'))).resolves.toEqual({
      text: "/lai argument parse error: unmatched quote",
    });
  });

  it("parses codex account list output", () => {
    expect(
      parseCodexAccountsList(
        "1\te4b330fdab6c99f1\tyikecha02@gmail.com [default active]\n2\td6e1856ff0a57fb1\tlinzhinan1024@gmail.com\n",
      ),
    ).toEqual([
      {
        index: "1",
        id: "e4b330fdab6c99f1",
        label: "yikecha02@gmail.com",
        flags: ["default", "active"],
      },
      {
        index: "2",
        id: "d6e1856ff0a57fb1",
        label: "linzhinan1024@gmail.com",
        flags: [],
      },
    ]);
  });

  it("parses lai interactive payloads", () => {
    expect(parseLaiInteractivePayload("usage-all")).toEqual({
      action: "usage-all",
    });
    expect(parseLaiInteractivePayload("open-switch")).toEqual({
      action: "open-switch",
    });
    expect(parseLaiInteractivePayload("switch-account:e4b330fdab6c99f1")).toEqual({
      action: "switch-account",
      account: "e4b330fdab6c99f1",
    });
  });

  it("opens the switch menu only after clicking Codex Switch", async () => {
    const exec = vi.fn(async (_cmd: string, argv: string[]) => {
      if (argv.join(" ") === "codex accounts list") {
        return {
          stdout:
            "1\te4b330fdab6c99f1\tyikecha02@gmail.com [default active]\n2\td6e1856ff0a57fb1\tlinzhinan1024@gmail.com\n",
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });

    await expect(
      handleLaiInteractiveAction(true, "open-switch", {
        deps: createDeps(exec),
      }),
    ).resolves.toMatchObject({
      kind: "menu",
      text: expect.stringContaining("Choose a Codex account."),
      interactive: {
        blocks: [
          {
            type: "buttons",
            buttons: expect.arrayContaining([
              expect.objectContaining({
                label: "#1 yikecha02@gmail.com [default active]",
                value: "lai:switch-account:e4b330fdab6c99f1",
              }),
              expect.objectContaining({
                label: "#2 linzhinan1024@gmail.com",
                value: "lai:switch-account:d6e1856ff0a57fb1",
              }),
            ]),
          },
        ],
      },
    });
  });

  it("runs switch then sync-auth when an account button is chosen", async () => {
    const exec = vi.fn(async (_cmd: string, argv: string[]) => {
      if (argv.join(" ") === "codex accounts switch e4b330fdab6c99f1") {
        return { stdout: "switched\n", stderr: "" };
      }
      if (argv.join(" ") === "codex sync-auth e4b330fdab6c99f1") {
        return { stdout: "synced\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    await expect(
      handleLaiInteractiveAction(true, "switch-account:e4b330fdab6c99f1", {
        deps: createDeps(exec),
      }),
    ).resolves.toEqual({
      kind: "text",
      text: [
        "Codex account switched and synced: e4b330fdab6c99f1",
        "",
        "$ lai codex accounts switch",
        "switched",
        "",
        "$ lai codex sync-auth",
        "synced",
      ].join("\n"),
    });
  });

  it("runs lai directly when args are provided", async () => {
    const exec = vi.fn(async () => ({ stdout: "ok\n", stderr: "" })) as never;

    await expect(
      handleLaiCommand(createContext("codex status"), {
        deps: createDeps(exec),
      }),
    ).resolves.toEqual({ text: "ok" });

    expect(exec).toHaveBeenCalledWith(
      "/usr/bin/lai",
      ["codex", "status"],
      expect.objectContaining({
        encoding: "utf8",
        timeout: 120_000,
      }),
    );
  });

  it("returns a clear error when lai is unavailable", async () => {
    await expect(
      handleLaiCommand(createContext("codex status"), {
        deps: {
          resolveCommand: async () => null,
          env: { PATH: "/usr/bin", HOME: "/home/test" },
          readFile: vi.fn(async () => "") as never,
        },
      }),
    ).resolves.toEqual({
      text: "lai is not available on PATH. Install lai or expose it in PATH before using /lai.",
    });
  });
});
