#!/usr/bin/env node
// Stashwise MCP entrypoint.
//
//   npx -y @stashwiseapp/mcp                 → stdio MCP server (default)
//   npx -y @stashwiseapp/mcp auth            → one-time device-code login
//   npx -y @stashwiseapp/mcp search "..."    → search from the terminal
//   npx -y @stashwiseapp/mcp doctor          → config + token + backend health
//
// Codex's review confirmed: a separate CLI binary buys nothing — single
// binary with subcommand modes is the production pattern (Stripe, Linear,
// Atlassian, every other MCP server in 2026 ships this way).

import { runAuth } from "./auth.js";
import { runDoctor } from "./doctor.js";
import { runSearch } from "./search.js";
import { runServe } from "./serve.js";
import { VERSION } from "./version.js";

type Mode = "serve" | "auth" | "search" | "doctor" | "help" | "version" | "unknown";

function parseMode(argv: string[]): Mode {
  const raw = (argv[2] ?? "").toLowerCase();
  if (!raw) return "serve";
  if (raw === "auth" || raw === "login") return "auth";
  if (raw === "search") return "search";
  if (raw === "doctor" || raw === "status") return "doctor";
  if (raw === "--help" || raw === "-h" || raw === "help") return "help";
  if (raw === "--version" || raw === "-v" || raw === "version") return "version";
  return "unknown";
}

function printHelp(): void {
  process.stdout.write(
    [
      "",
      "Stashwise MCP — search your Stashwise library + wiki from any AI agent, or your terminal.",
      "",
      "Usage:",
      "  npx -y @stashwiseapp/mcp                 Start the stdio MCP server (default).",
      "  npx -y @stashwiseapp/mcp auth            Pair this machine with your Stashwise account.",
      '  npx -y @stashwiseapp/mcp search "..."    Search your library/wiki from the terminal.',
      "  npx -y @stashwiseapp/mcp doctor          Check config, token, and backend reachability.",
      "  npx -y @stashwiseapp/mcp --version       Print the installed version.",
      "",
      "Search flags:",
      "  --scope library|wiki|all   Limit the search surface (default: all).",
      "  --k 1-25                   Max results to return (default: 8).",
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
