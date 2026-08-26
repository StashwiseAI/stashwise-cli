// Recognising, inserting and removing our MCP server entry in a client's config.
//
// Pure: plain objects in, plain objects out, no filesystem. Same reason
// `hook-install.ts` splits this way, and the same payoff, which is that the
// tests below never touch a real home directory.
//
// The hard part is not writing the entry, it is recognising the ones already
// there. Stashwise has been configured four different ways over four releases:
// a bare npx invocation, a `--package` pin under the old `mcp` binary name, a
// hosted url on the platform host, and a hosted url on the branded host. Miss
// any of them and `installServerEntry` appends beside it, leaving the client
// with two Stashwise servers, one of them stale. `hook.test.ts` documents the
// same failure for hooks and it is the reason that predicate is as broad as it
// is.

/** Keys we have ever written, or that a person plausibly typed for us. */
const STASHWISE_KEYS = new Set(["stashwise", "stashwise-local", "stashwise-mcp"]);

export const CANONICAL_KEY = "stashwise";

const PACKAGE_NAME = "@stashwiseapp/mcp";

/** Hosts that have served our MCP endpoint. */
const STASHWISE_HOSTS = [/^(.+\.)?stashwise\.co$/, /^stashwise-api\.fly\.dev$/];

function basename(command: string): string {
  const parts = command.split(/[\\/]/);
  return parts[parts.length - 1] ?? command;
}

function isStashwiseUrl(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  try {
    const url = new URL(raw);
    return (
      STASHWISE_HOSTS.some((re) => re.test(url.hostname)) && url.pathname.startsWith("/mcp")
    );
  } catch {
    return false;
  }
}

/**
 * Is this entry one of ours, in any shape we have ever written?
 *
 * `key` matters for one case only. The pre 0.4.0 binary was called `mcp`, which
 * is far too generic a name to claim on sight: someone else's `mcp` command is
 * not ours to replace. Requiring it to sit under a Stashwise key as well keeps
 * that migration without hijacking a stranger's server.
 */
export function isStashwiseServerEntry(entry: unknown, key: string): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const record = entry as Record<string, unknown>;

  if (isStashwiseUrl(record.url)) return true;

  const command = typeof record.command === "string" ? record.command : "";
  const args = Array.isArray(record.args) ? record.args : [];
  const line = [command, ...args.map((a) => (typeof a === "string" ? a : ""))].join(" ");
  if (line.includes(PACKAGE_NAME)) return true;
  if (command && basename(command) === "stashwise") return true;
  if (command && basename(command) === "mcp" && STASHWISE_KEYS.has(key)) return true;
  return false;
}

export type InstallAction = "created" | "replaced" | "unchanged" | "refused";

export interface MergeResult {
  doc: Record<string, unknown>;
  changed: boolean;
  action: InstallAction;
  /** Duplicate Stashwise entries collapsed into the canonical key. */
  removedKeys: string[];
  reason?: string;
}

function container(
  doc: Record<string, unknown>,
  containerKey: string,
): Record<string, unknown> | null {
  const existing = doc[containerKey];
  if (existing === undefined) {
    const fresh: Record<string, unknown> = {};
    doc[containerKey] = fresh;
    return fresh;
  }
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
    return null;
  }
  return existing as Record<string, unknown>;
}

function sameEntry(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function installServerEntry(
  doc: Record<string, unknown>,
  containerKey: string,
  entry: Record<string, unknown>,
): MergeResult {
  const servers = container(doc, containerKey);
  if (servers === null) {
    return {
      doc,
      changed: false,
      action: "refused",
      removedKeys: [],
      reason: `"${containerKey}" is not an object`,
    };
  }

  const ours = Object.keys(servers).filter((key) => isStashwiseServerEntry(servers[key], key));

  if (ours.length === 0) {
    if (Object.prototype.hasOwnProperty.call(servers, CANONICAL_KEY)) {
      // Someone else's server is sitting under our name. Replacing it would
      // break their setup to make room for ours.
      return {
        doc,
        changed: false,
        action: "refused",
        removedKeys: [],
        reason: `a different server is already registered as "${CANONICAL_KEY}"`,
      };
    }
    servers[CANONICAL_KEY] = entry;
    return { doc, changed: true, action: "created", removedKeys: [] };
  }

  // Write back into a key that already exists, so the entry keeps its place in
  // the file and the user's diff is one hunk rather than a reordering.
  const target = ours.includes(CANONICAL_KEY) ? CANONICAL_KEY : ours[0];
  const removedKeys = ours.filter((key) => key !== target);
  const unchanged = sameEntry(servers[target], entry) && removedKeys.length === 0;
  if (unchanged) {
    return { doc, changed: false, action: "unchanged", removedKeys: [] };
  }
  servers[target] = entry;
  for (const key of removedKeys) delete servers[key];
  return { doc, changed: true, action: "replaced", removedKeys };
}

export function removeServerEntry(
  doc: Record<string, unknown>,
  containerKey: string,
): { doc: Record<string, unknown>; removedKeys: string[] } {
  const existing = doc[containerKey];
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
    return { doc, removedKeys: [] };
  }
  const servers = existing as Record<string, unknown>;
  const removedKeys = Object.keys(servers).filter((key) =>
    isStashwiseServerEntry(servers[key], key),
  );
  for (const key of removedKeys) delete servers[key];
  // Leave no residue: an empty container we created is not the user's.
  if (Object.keys(servers).length === 0) delete doc[containerKey];
  return { doc, removedKeys };
}
