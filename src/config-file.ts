// Reading and writing config files that belong to other applications.
//
// `hook-install.ts` had a version of this for the one file it touched. Install
// touches up to seven, owned by editors that may be running while we write, so
// the parts that file got away without are now load bearing:
//
//   atomic       rename, never a truncated file observed mid write. `~/.claude.json`
//                is 168KB of state a live Claude Code session rereads at will.
//   backup       one copy beside the original before every change.
//   mode         preserved exactly. `~/.claude.json` is 0600 and holds plaintext
//                API tokens; creating it 0644 would widen someone's secrets.
//   indent       sniffed from the file. Reformatting a hand written config into
//                our house style turns one line of diff into hundreds.
//   root guard   we never create a client's root directory. If `~/.codeium` is
//                absent the user does not have Windsurf, and littering it there
//                would be worse than doing nothing.
//
// The classification is deliberately richer than valid/invalid. A config with
// comments in it is not corrupt, it is JSONC, and the honest response is to hand
// the user a snippet rather than to silently strip their comments or to refuse
// with a parse error that blames them for a file that is fine.

import {
  chmodSync,
  copyFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type ConfigKind =
  /** No file yet. Fine, as long as the client's root directory exists. */
  | "missing"
  /** Strict JSON, and an object. The only kind we write. */
  | "json"
  /** Parses, but is an array or a scalar. Not something we can merge into. */
  | "not-object"
  /** Fails strict parse, parses once comments and trailing commas are removed. */
  | "jsonc"
  /** Fails both. Something is actually broken, and it is not ours to fix. */
  | "corrupt";

export interface ClassifiedRead {
  kind: ConfigKind;
  /** Present for "json" only. Never for "jsonc": we classify those, never edit them. */
  doc: Record<string, unknown> | null;
  raw: string | null;
  /** Existing permission bits, so a write can put them back. */
  mode: number | null;
  indent: string;
  /** The parser's own words, for "corrupt". Ours would be vaguer. */
  error: string | null;
}

const DEFAULT_INDENT = "  ";
/** New files are private by default. Only widen if the user already had. */
const NEW_FILE_MODE = 0o600;

/**
 * Strip comments and trailing commas, respecting strings and escapes.
 *
 * Used to tell JSONC apart from genuine corruption, and for nothing else. Its
 * output is never written: a stripper good enough to classify is not good enough
 * to hand someone back their own file.
 */
function stripJsonc(raw: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    const next = raw[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 1;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** The indentation the file already uses, so a rewrite reads as one edit. */
function sniffIndent(raw: string): string {
  const match = raw.match(/\n([ \t]+)\S/);
  return match ? match[1] : DEFAULT_INDENT;
}

export function classifyJson(raw: string): {
  kind: Exclude<ConfigKind, "missing">;
  doc: Record<string, unknown> | null;
  error: string | null;
} {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { kind: "json", doc: parsed as Record<string, unknown>, error: null };
    }
    return { kind: "not-object", doc: null, error: null };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    try {
      const relaxed = JSON.parse(stripJsonc(raw)) as unknown;
      if (typeof relaxed === "object" && relaxed !== null && !Array.isArray(relaxed)) {
        return { kind: "jsonc", doc: null, error: null };
      }
      return { kind: "corrupt", doc: null, error: detail };
    } catch {
      return { kind: "corrupt", doc: null, error: detail };
    }
  }
}

export function readJsonConfig(path: string): ClassifiedRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {
      kind: "missing",
      doc: null,
      raw: null,
      mode: null,
      indent: DEFAULT_INDENT,
      error: null,
    };
  }
  let mode: number | null = null;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    mode = null;
  }
  const classified = classifyJson(raw);
  return {
    kind: classified.kind,
    doc: classified.doc,
    raw,
    mode,
    indent: sniffIndent(raw),
    error: classified.error,
  };
}

export interface WriteOptions {
  /** Must already exist. We create the file's own directory, never this. */
  rootDir?: string;
  mode?: number | null;
  indent?: string;
  backup?: boolean;
}

/**
 * Replace a config file without anyone ever seeing it half written.
 *
 * Temp file in the same directory, so the rename cannot cross a filesystem
 * boundary and degrade into a copy.
 */
export function writeJsonConfig(
  path: string,
  value: unknown,
  options: WriteOptions = {},
): { backupPath: string | null } {
  const { rootDir, mode, indent = DEFAULT_INDENT, backup = true } = options;
  if (rootDir && !existsSync(rootDir)) {
    throw new Error(`Refusing to create ${rootDir}: that client is not installed.`);
  }
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  let backupPath: string | null = null;
  if (backup && existsSync(path)) {
    backupPath = `${path}.stashwise-backup`;
    copyFileSync(path, backupPath);
  }

  const tmp = join(dir, `.stashwise-tmp-${process.pid}`);
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, indent)}\n`, "utf8");
    // Durable before the rename, or a crash can leave the new name pointing at
    // an empty file, which is worse than the old contents.
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, mode ?? NEW_FILE_MODE);
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Already gone, or never created. Nothing to clean up.
    }
    throw err;
  }
  return { backupPath };
}
