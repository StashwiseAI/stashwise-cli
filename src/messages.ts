// Shared user-facing messages, so the MCP server (serve.ts) and the direct
// `search` command surface identical guidance.

export function notAuthenticatedHint(): string {
  return [
    "Stashwise is not authenticated.",
    "Run `npx -y @stashwiseapp/mcp auth` to link this machine to your Stashwise account.",
  ].join(" ");
}
