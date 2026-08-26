import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readJsonConfig, writeJsonConfig } from "../src/config-file.js";

// The only suite here that touches a real filesystem, and only because what it
// checks are filesystem properties. Mocking permission bits and atomic rename
// would be testing the mock.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "stashwise-config-"));
  dirs.push(dir);
  return dir;
}

describe("writing someone else's config file", () => {
  it("keeps the permissions the file already had", () => {
    // ~/.claude.json is 0600 and holds plaintext API tokens. Writing it back as
    // 0644 would widen a stranger's secrets as a side effect of our install.
    const dir = scratch();
    const path = join(dir, "config.json");
    writeFileSync(path, '{"a":1}\n');
    chmodSync(path, 0o600);
    writeJsonConfig(path, { a: 2 }, { mode: statSync(path).mode & 0o777 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("creates a new file private, not world readable", () => {
    const dir = scratch();
    const path = join(dir, "new.json");
    writeJsonConfig(path, { a: 1 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("leaves a backup holding the previous bytes", () => {
    const dir = scratch();
    const path = join(dir, "config.json");
    writeFileSync(path, '{"old":true}\n');
    const { backupPath } = writeJsonConfig(path, { old: false });
    expect(backupPath).toBe(`${path}.stashwise-backup`);
    expect(JSON.parse(readFileSync(backupPath!, "utf8"))).toEqual({ old: true });
  });

  it("leaves no temp files behind", () => {
    const dir = scratch();
    writeJsonConfig(join(dir, "config.json"), { a: 1 });
    expect(readdirSync(dir).filter((f) => f.includes("tmp"))).toEqual([]);
  });

  it("refuses to create a client root that does not exist", () => {
    // An absent root means the client is not installed. Creating it would
    // litter a config onto a machine that has never run that tool.
    const dir = scratch();
    const root = join(dir, "never-installed");
    expect(() =>
      writeJsonConfig(join(root, "mcp.json"), { a: 1 }, { rootDir: root }),
    ).toThrow(/not installed/);
    expect(existsSync(root)).toBe(false);
  });

  it("creates the file's own directory beneath a root that does exist", () => {
    const dir = scratch();
    const path = join(dir, "windsurf", "mcp_config.json");
    writeJsonConfig(path, { a: 1 }, { rootDir: dir });
    expect(existsSync(path)).toBe(true);
  });

  it("keeps the file's own indentation", () => {
    const dir = scratch();
    const path = join(dir, "config.json");
    writeFileSync(path, '{\n    "a": 1\n}\n');
    const read = readJsonConfig(path);
    expect(read.indent).toBe("    ");
    writeJsonConfig(path, { a: 1, b: 2 }, { indent: read.indent });
    expect(readFileSync(path, "utf8")).toContain('\n    "b"');
  });

  it("ends the file with a newline, as every editor expects", () => {
    const dir = scratch();
    const path = join(dir, "config.json");
    writeJsonConfig(path, { a: 1 });
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
  });
});

describe("reading", () => {
  it("reports a missing file as missing rather than broken", () => {
    expect(readJsonConfig(join(scratch(), "nope.json")).kind).toBe("missing");
  });

  it("carries the mode and indent back for the writer to reuse", () => {
    const dir = scratch();
    const path = join(dir, "config.json");
    writeFileSync(path, '{\n  "a": 1\n}\n');
    chmodSync(path, 0o644);
    const read = readJsonConfig(path);
    expect(read.mode).toBe(0o644);
    expect(read.indent).toBe("  ");
    expect(read.doc).toEqual({ a: 1 });
  });

  it("hands back no document for a commented file, so nothing can write it", () => {
    const dir = scratch();
    const path = join(dir, "config.json");
    writeFileSync(path, '{\n  // mine\n  "a": 1\n}\n');
    const read = readJsonConfig(path);
    expect(read.kind).toBe("jsonc");
    expect(read.doc).toBeNull();
  });
});
