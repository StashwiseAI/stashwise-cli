import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface HookCommand {
  type: string;
  command: string;
  commandWindows?: string;
  timeout?: number;
  statusMessage?: string;
}

interface HookConfig {
  hooks: {
    UserPromptSubmit: Array<{
      matcher?: string;
      hooks: HookCommand[];
    }>;
  };
}

const hookPath = fileURLToPath(
  new URL("../plugins/stashwise/hooks/hooks.json", import.meta.url),
);

const marketplacePath = fileURLToPath(
  new URL("../.agents/plugins/marketplace.json", import.meta.url),
);

const installerPath = fileURLToPath(
  new URL("../scripts/install-codex-plugin.sh", import.meta.url),
);

function loadHook(): HookCommand {
  const config = JSON.parse(readFileSync(hookPath, "utf8")) as HookConfig;
  expect(config.hooks.UserPromptSubmit).toHaveLength(1);
  const group = config.hooks.UserPromptSubmit[0];
  expect(group.matcher).toBeUndefined();
  expect(group.hooks).toHaveLength(1);
  return group.hooks[0];
}

describe("Stashwise Codex plugin hook", () => {
  it("bundles a quiet, dependency-free UserPromptSubmit hook", () => {
    const hook = loadHook();

    expect(hook.type).toBe("command");
    expect(hook.timeout).toBe(2);
    expect(hook.statusMessage).toBeUndefined();
    expect(hook.command).toMatch(/^printf /);
    expect(hook.commandWindows).toMatch(/^powershell\.exe /);

    for (const command of [hook.command, hook.commandWindows ?? ""]) {
      expect(command).toContain("[Stashwise ambient context]");
      expect(command).toContain("read-only Stashwise tool");
      expect(command).toContain("Skip Stashwise for greetings");
      expect(command).toContain("refine the query once");
      expect(command).toContain("Loading the skill alone does not count");
      expect(command).toContain("get_stashwise_context");
      expect(command).toContain("Never write to Stashwise unless the user explicitly asks");
      expect(command).not.toMatch(
        /\b(curl|wget|fetch|http|token|keychain|Invoke-WebRequest)\b/i,
      );
    }
  });

  it("prints ambient developer context without echoing the submitted prompt", () => {
    const hook = loadHook();
    const privatePrompt = "A private prompt that must not be echoed";
    const result = spawnSync("/bin/sh", ["-c", hook.command], {
      encoding: "utf8",
      input: JSON.stringify({
        session_id: "test-session",
        turn_id: "test-turn",
        hook_event_name: "UserPromptSubmit",
        prompt: privatePrompt,
      }),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput: {
        hookEventName: string;
        additionalContext: string;
      };
    };
    expect(output.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "[Stashwise ambient context]",
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "private research saved in Stashwise",
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "hydrate every result used in a substantive answer",
    );
    expect(result.stdout).not.toContain(privatePrompt);
  });
});

describe("Stashwise Codex retrieval skill", () => {
  it("hydrates every search result used as evidence", () => {
    const skillPath = fileURLToPath(
      new URL(
        "../plugins/stashwise/skills/search-stashwise/SKILL.md",
        import.meta.url,
      ),
    );
    const skill = readFileSync(skillPath, "utf8");

    expect(skill).toContain("candidates, not complete evidence");
    expect(skill).toContain("call `get_stashwise_context`");
    expect(skill).toContain("Hydrate every result the answer relies on");
    expect(skill).toContain("source takeaways");
    expect(skill).toContain("a completed read-only tool call is required");
  });
});

describe("Stashwise Codex marketplace", () => {
  it("uses a public identity and ships an executable installer", () => {
    const marketplace = JSON.parse(readFileSync(marketplacePath, "utf8")) as {
      name: string;
      interface: { displayName: string };
      plugins: Array<{ name: string }>;
    };

    expect(marketplace.name).toBe("stashwise");
    expect(marketplace.interface.displayName).toBe("Stashwise");
    expect(marketplace.plugins.map((plugin) => plugin.name)).toContain("stashwise");
    expect(statSync(installerPath).mode & 0o111).not.toBe(0);
  });
});

describe("skill activation metadata", () => {
  // A host sees only the skill's name and description when deciding whether to
  // load it; the body is read afterward. So a description that says what the
  // skill DOES, rather than when to activate it, is invisible at exactly the
  // moment the decision is made. That is the same failure already fixed on the
  // MCP tool description and the server instructions.
  const frontmatter = () => {
    const skillPath = fileURLToPath(
      new URL(
        "../plugins/stashwise/skills/search-stashwise/SKILL.md",
        import.meta.url,
      ),
    );
    const raw = readFileSync(skillPath, "utf8");
    const match = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!match) throw new Error("SKILL.md has no frontmatter block");
    return match[1];
  };

  it("names the triggering question types in the description", () => {
    const description = frontmatter().toLowerCase();

    for (const kind of ["recommendation", "planning", "comparison", "recall"]) {
      expect(description).toContain(kind);
    }
    // The indirect case is the one that fails in practice.
    expect(description).toContain("does not mention stashwise");
    // Must stay short: it is matched during selection, not read as a body.
    expect(description.length).toBeLessThan(400);
  });

  it("keeps the manifest as routing copy rather than a feature list", () => {
    const manifestPath = fileURLToPath(
      new URL("../plugins/stashwise/.codex-plugin/plugin.json", import.meta.url),
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const blob = (
      manifest.description + " " + manifest.interface.longDescription
    ).toLowerCase();

    expect(blob).toContain("recommendation");
    expect(blob).toContain("not mention");
  });
});

describe("Stashwise Claude Code marketplace", () => {
  const claudeMarketplacePath = fileURLToPath(
    new URL("../.claude-plugin/marketplace.json", import.meta.url),
  );
  const claudeManifestPath = fileURLToPath(
    new URL("../plugins/stashwise/.claude-plugin/plugin.json", import.meta.url),
  );
  const codexManifestPath = fileURLToPath(
    new URL("../plugins/stashwise/.codex-plugin/plugin.json", import.meta.url),
  );

  const readJson = (path: string) =>
    JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;

  it("catalogs the plugin from inside the marketplace repository", () => {
    const marketplace = readJson(claudeMarketplacePath);

    expect(marketplace.name).toBe("stashwise");
    expect(marketplace.owner?.name).toBe("StashwiseAI");

    expect(marketplace.plugins).toHaveLength(1);
    const [entry] = marketplace.plugins;
    expect(entry.name).toBe("stashwise");
    // Claude Code resolves this against the marketplace root, not
    // .claude-plugin/, and refuses anything that climbs out with "../".
    expect(entry.source).toBe("./plugins/stashwise");
  });

  it("ships a manifest that namespaces the skill as stashwise", () => {
    const manifest = readJson(claudeManifestPath);

    expect(manifest.name).toBe("stashwise");
    // Skills, hooks and the MCP definition all sit at their auto-detected
    // default paths. Naming them here can replace the default scan rather
    // than supplement it, so the manifest stays pure metadata.
    for (const field of ["skills", "hooks", "mcpServers", "commands", "agents"]) {
      expect(manifest[field]).toBeUndefined();
    }
  });

  it("pins the same version as the Codex manifest", () => {
    // Both hosts install the same directory, and each pins updates to its own
    // manifest version. Bumping one alone leaves the other host's users on a
    // stale cached copy with no error anywhere to show for it.
    expect(readJson(claudeManifestPath).version).toBe(
      readJson(codexManifestPath).version,
    );
  });

  it("carries routing copy on both surfaces a user reads before installing", () => {
    const description = readJson(claudeManifestPath).description as string;
    const entryDescription = readJson(claudeMarketplacePath).plugins[0]
      .description as string;

    // The catalog entry is what the /plugin Discover tab shows, and the
    // manifest is what the installed detail view shows. Neither may drift
    // back into a feature list.
    expect(entryDescription).toBe(description);
    for (const blob of [description.toLowerCase()]) {
      expect(blob).toContain("recommendation");
      expect(blob).toContain("not mentioned");
    }
  });
});
