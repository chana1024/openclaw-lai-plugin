import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import plugin from "./index.js";

describe("lai plugin", () => {
  it("is opt-in by default", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { enabledByDefault?: unknown };

    expect(manifest.enabledByDefault).toBeUndefined();
  });

  it("registers the lai runtime slash command", () => {
    const registerCommand = vi.fn();
    const registerInteractiveHandler = vi.fn();

    plugin.register(
      createTestPluginApi({
        id: "lai",
        name: "LAI",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {} as never,
        registerCommand,
        registerInteractiveHandler,
      }),
    );

    expect(registerCommand).toHaveBeenCalledTimes(1);
    expect(registerCommand.mock.calls[0]?.[0]).toMatchObject({
      name: "lai",
      description: "Run lai directly without LLM interpretation",
    });
    expect(registerInteractiveHandler).toHaveBeenCalledTimes(3);
    expect(registerInteractiveHandler.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: "telegram", namespace: "lai" }),
        expect.objectContaining({ channel: "discord", namespace: "lai" }),
        expect.objectContaining({ channel: "slack", namespace: "lai" }),
      ]),
    );
  });
});
