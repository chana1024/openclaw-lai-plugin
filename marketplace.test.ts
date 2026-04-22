import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("lai marketplace", () => {
  it("points marketplace installs at the nested plugin package", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("./marketplace.json", import.meta.url), "utf8"),
    ) as {
      plugins?: Array<{ name?: unknown; source?: unknown }>;
    };

    expect(manifest.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "lai",
          source: "./plugins/lai",
        }),
      ]),
    );
  });

  it("keeps the workspace bridge entry pointed at the nested plugin", () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
      openclaw?: { extensions?: unknown };
    };

    expect(pkg.openclaw?.extensions).toEqual(["./plugins/lai/index.ts"]);
  });
});
