#!/usr/bin/env node
// Stashwise MCP entrypoint.
//
//   npx -y --package @stashwiseapp/mcp@latest mcp              → stdio MCP server (default)
//   npx -y --package @stashwiseapp/mcp@latest mcp auth         → one-time device-code login
//   npx -y --package @stashwiseapp/mcp@latest mcp search "..." → search from the terminal
//   npx -y --package @stashwiseapp/mcp@latest mcp doctor       → config + token + backend health
//   npx -y --package @stashwiseapp/mcp@latest mcp hook install → register the Claude Code prompt hook
//
// Codex's review confirmed: a separate CLI binary buys nothing — single
// binary with subcommand modes is the production pattern (Stripe, Linear,
// Atlassian, every other MCP server in 2026 ships this way).

import { runAuth } from "./auth.js";
import {
  STASHWISE_MCP_AUTH_COMMAND,
  STASHWISE_MCP_DOCTOR_COMMAND,
  STASHWISE_MCP_HOOK_COMMAND,
  STASHWISE_MCP_RUN_COMMAND,
  STASHWISE_MCP_SEARCH_COMMAND,
} from "./commands.js";
import { runDoctor } from "./doctor.js";
import { runHook } from "./hook.js";
import { runHookInstall, runHookUninstall } from "./hook-install.js";
import { runSearch } from "./search.js";
import { runServe } from "./serve.js";
import { VERSION } from "./version.js";

type Mode =
  | "serve"
  | "auth"
  | "search"
  | "doctor"
  | "hook"
  | "help"
  | "version"
  | "unknown";

function parseMode(argv: string[]): Mode {
  const raw = (argv[2] ?? "").toLowerCase();
  if (!raw) return "serve";
  if (raw === "auth" || raw === "login") return "auth";
  if (raw === "search") return "search";
  if (raw === "doctor" || raw === "status") return "doctor";
  if (raw === "hook") return "hook";
  if (raw === "--help" || raw === "-h" || raw === "help") return "help";
  if (raw === "--version" || raw === "-v" || raw === "version") return "version";
  return "unknown";
}

async function runHookMode(args: string[]): Promise<number> {
  const sub = (args[0] ?? "").toLowerCase();
  if (sub === "install") return runHookInstall();
  if (sub === "uninstall") return runHookUninstall();
  if (sub === "" || sub.startsWith("--")) return runHook(args);
  process.stderr.write(
    `Unknown hook subcommand: ${args[0]}\nUsage: ${STASHWISE_MCP_HOOK_COMMAND} [install|uninstall] [--min-score 0-1] [--k 1-25] [--timeout-ms 100-60000]\n`,
  );
  return 2;
}

function printHelp(): void {
  process.stdout.write(
    [
      "",
      "Stashwise MCP — search your Stashwise library + wiki from any AI agent, or your terminal.",
      "",
      "Usage:",
      `  ${STASHWISE_MCP_RUN_COMMAND}                 Start the stdio MCP server (default).`,
      `  ${STASHWISE_MCP_AUTH_COMMAND}            Pair this machine with your Stashwise account.`,
      `  ${STASHWISE_MCP_SEARCH_COMMAND} "..."    Search your library/wiki from the terminal.`,
      `  ${STASHWISE_MCP_DOCTOR_COMMAND}          Check config, token, and backend reachability.`,
      `  ${STASHWISE_MCP_HOOK_COMMAND} install    Register the Claude Code prompt suggestion hook.`,
      `  ${STASHWISE_MCP_HOOK_COMMAND} uninstall  Remove the prompt suggestion hook.`,
      `  ${STASHWISE_MCP_RUN_COMMAND} --version       Print the installed version.`,
      "",
      "Search flags:",
      "  --scope library|wiki|all   Limit the search surface (default: all).",
      "  --k 1-25                   Max results to return (default: 8).",
      "",
      "Hook flags (set on the command in settings.json):",
      "  --min-score 0-1            Relevance threshold for suggestions (default: 0.45).",
      "  --k 1-25                   Results fetched per prompt (default: 6).",
      "  --timeout-ms 100-60000     Search timeout before staying silent (default: 2500).",
      "",
      "Environment:",
      "  STASHWISE_API_URL   Override the backend URL (default https://stashwise-api.fly.dev/api/v1).",
      "  STASHWISE_WEB_URL   Override the webapp URL (default https://stashwise.co).",
      "",
      "Docs: https://stashwise.co/mcp",
      "",
    ].join("\n") + "\n",
  );
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv);
  let exitCode = 0;

  switch (mode) {
    case "auth":
      exitCode = await runAuth();
      break;
    case "search":
      exitCode = await runSearch(process.argv.slice(3));
      break;
    case "doctor":
      exitCode = await runDoctor();
      break;
    case "hook":
      exitCode = await runHookMode(process.argv.slice(3));
      break;
    case "help":
      printHelp();
      break;
    case "version":
      process.stdout.write(`${VERSION}\n`);
      break;
    case "unknown":
      process.stderr.write(
        `Unknown subcommand: ${process.argv[2]}\nRun with --help for usage.\n`,
      );
      exitCode = 2;
      break;
    case "serve":
    default:
      // runServe returns a never-resolving promise; only resolves if the
      // server crashes, in which case we exit non-zero.
      exitCode = await runServe();
      break;
  }

  process.exit(exitCode);
}

void main().catch((err: unknown) => {
  process.stderr.write(
    `Fatal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
