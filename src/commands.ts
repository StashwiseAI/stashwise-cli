// Command strings shown to humans, in two forms.
//
// The binary is `stashwise` (it was `mcp` through 0.3.0 — too generic a name to
// occupy on someone's PATH, which is why a global install could never be
// recommended). Now that it can be, anything printed to a person uses the short
// form, and the npx form is reserved for places where the binary may not be on
// PATH at all: the `--help` fallback, README setup snippets, and the pinned
// command written into ~/.claude/settings.json.

export const STASHWISE_BIN = "stashwise";

export const STASHWISE_MCP_PACKAGE_SPEC = "@stashwiseapp/mcp@latest";
export const STASHWISE_MCP_RUN_COMMAND = `npx -y --package ${STASHWISE_MCP_PACKAGE_SPEC} ${STASHWISE_BIN}`;

export const STASHWISE_AUTH_COMMAND = `${STASHWISE_BIN} auth`;
export const STASHWISE_SEARCH_COMMAND = `${STASHWISE_BIN} search`;
export const STASHWISE_DOCTOR_COMMAND = `${STASHWISE_BIN} doctor`;
export const STASHWISE_HOOK_COMMAND = `${STASHWISE_BIN} hook`;
