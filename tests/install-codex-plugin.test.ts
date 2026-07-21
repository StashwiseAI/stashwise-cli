import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const installerPath = fileURLToPath(
  new URL("../scripts/install-codex-plugin.sh", import.meta.url),
);

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createFakeCodex(): { binDirectory: string; logPath: string } {
  const directory = mkdtempSync(join(tmpdir(), "stashwise-codex-install-"));
  tempDirectories.push(directory);
  const logPath = join(directory, "codex.log");
  const codexPath = join(directory, "codex");
  writeFileSync(
    codexPath,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CODEX_LOG"
if [ "$*" = "plugin marketplace list" ]; then
  printf '%s\\n' "$FAKE_MARKETPLACE_LIST"
elif [ "$*" = "plugin list" ]; then
  printf '%s\\n' "$FAKE_PLUGIN_LIST"
elif [ "$*" = "plugin add stashwise@stashwise --json" ]; then
  printf '{"pluginId":"stashwise@stashwise","version":"0.1.2"}\\n'
fi
`,
  );
  chmodSync(codexPath, 0o755);
  return { binDirectory: directory, logPath };
}

describe("Codex plugin installer", () => {
  it("installs Stashwise from the official marketplace for a clean user", () => {
    const fakeCodex = createFakeCodex();
    const result = spawnSync("/bin/sh", [installerPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_CODEX_LOG: fakeCodex.logPath,
        FAKE_MARKETPLACE_LIST: "MARKETPLACE ROOT",
        FAKE_PLUGIN_LIST: "PLUGIN STATUS VERSION PATH",
        PATH: `${fakeCodex.binDirectory}${delimiter}${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(readFileSync(fakeCodex.logPath, "utf8").trim().split("\n")).toEqual([
      "plugin marketplace list",
      "plugin marketplace add StashwiseAI/stashwise-cli --ref main",
      "plugin list",
      "plugin add stashwise@stashwise --json",
    ]);
    expect(result.stdout).toContain("Stashwise 0.1.2 is installed in Codex");
    expect(result.stdout).toContain("/hooks");
    expect(result.stdout).toContain("start a new task");
  });

  it("refreshes an existing marketplace and replaces the cached plugin", () => {
    const fakeCodex = createFakeCodex();
    const result = spawnSync("/bin/sh", [installerPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_CODEX_LOG: fakeCodex.logPath,
        FAKE_MARKETPLACE_LIST: "stashwise  /tmp/stashwise",
        FAKE_PLUGIN_LIST:
          "stashwise@stashwise  installed, enabled  0.1.1  /tmp/stashwise",
        PATH: `${fakeCodex.binDirectory}${delimiter}${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(fakeCodex.logPath, "utf8").trim().split("\n")).toEqual([
      "plugin marketplace list",
      "plugin marketplace upgrade stashwise",
      "plugin list",
      "plugin remove stashwise@stashwise --json",
      "plugin add stashwise@stashwise --json",
    ]);
    expect(result.stdout).toContain("Stashwise 0.1.2 is installed in Codex");
  });

  it("migrates the legacy personal-marketplace installation", () => {
    const fakeCodex = createFakeCodex();
    const result = spawnSync("/bin/sh", [installerPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_CODEX_LOG: fakeCodex.logPath,
        FAKE_MARKETPLACE_LIST: "personal  /tmp/stashwise-cli",
        FAKE_PLUGIN_LIST:
          "stashwise@personal  installed, enabled  0.1.2  /tmp/stashwise",
        PATH: `${fakeCodex.binDirectory}${delimiter}${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(fakeCodex.logPath, "utf8").trim().split("\n")).toEqual([
      "plugin marketplace list",
      "plugin marketplace add StashwiseAI/stashwise-cli --ref main",
      "plugin list",
      "plugin remove stashwise@personal --json",
      "plugin add stashwise@stashwise --json",
    ]);
  });

  it("accepts a local marketplace source for contributor testing", () => {
    const fakeCodex = createFakeCodex();
    const result = spawnSync("/bin/sh", [installerPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_CODEX_LOG: fakeCodex.logPath,
        FAKE_MARKETPLACE_LIST: "MARKETPLACE ROOT",
        FAKE_PLUGIN_LIST: "PLUGIN STATUS VERSION PATH",
        PATH: `${fakeCodex.binDirectory}${delimiter}${process.env.PATH ?? ""}`,
        STASHWISE_CODEX_MARKETPLACE_SOURCE: "/tmp/stashwise-cli",
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(fakeCodex.logPath, "utf8").trim().split("\n")).toEqual([
      "plugin marketplace list",
      "plugin marketplace add /tmp/stashwise-cli",
      "plugin list",
      "plugin add stashwise@stashwise --json",
    ]);
  });

  it("reruns against an existing local marketplace without a Git upgrade", () => {
    const fakeCodex = createFakeCodex();
    const result = spawnSync("/bin/sh", [installerPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_CODEX_LOG: fakeCodex.logPath,
        FAKE_MARKETPLACE_LIST: "stashwise  /tmp/stashwise-cli",
        FAKE_PLUGIN_LIST:
          "stashwise@stashwise  installed, enabled  0.1.2  /tmp/stashwise",
        PATH: `${fakeCodex.binDirectory}${delimiter}${process.env.PATH ?? ""}`,
        STASHWISE_CODEX_MARKETPLACE_SOURCE: "/tmp/stashwise-cli",
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(fakeCodex.logPath, "utf8").trim().split("\n")).toEqual([
      "plugin marketplace list",
      "plugin list",
      "plugin remove stashwise@stashwise --json",
      "plugin add stashwise@stashwise --json",
    ]);
  });
});
