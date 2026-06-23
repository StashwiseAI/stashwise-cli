// Single source of truth for the package version. Read from package.json at
// runtime (via createRequire) so the MCP server handshake, `--version`, and
// the `doctor` output never drift from the published version again.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export const VERSION: string = pkg.version;
