// Shared user-facing messages, so the MCP server (serve.ts) and the direct
// `search` command surface identical guidance.

import { STASHWISE_MCP_AUTH_COMMAND } from "./commands.js";

export function notAuthenticatedHint(): string {
  return [
    "Stashwise is not authenticated.",
    `Run \`${STASHWISE_MCP_AUTH_COMMAND}\` to link this machine to your Stashwise account.`,
  ].join(" ");
}
