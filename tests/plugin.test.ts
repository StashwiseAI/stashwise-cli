import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
