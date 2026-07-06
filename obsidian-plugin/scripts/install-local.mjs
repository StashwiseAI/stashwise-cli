import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const pluginId = "stashwise-sync";
const repoRoot = path.resolve(import.meta.dirname, "..");
const vaultPath =
  process.env.STASHWISE_OBSIDIAN_VAULT ||
  process.argv[2] ||
  path.resolve(repoRoot, "..", "..");
const obsidianDir = path.join(vaultPath, ".obsidian");
const pluginDir = path.join(obsidianDir, "plugins", pluginId);

if (!existsSync(obsidianDir)) {
  process.stderr.write(
    `No .obsidian folder found at ${obsidianDir}\n` +
      "Pass a vault path as the first arg or set STASHWISE_OBSIDIAN_VAULT.\n",
  );
  process.exit(1);
}

await mkdir(pluginDir, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) {
  await copyFile(path.join(repoRoot, file), path.join(pluginDir, file));
}

await enablePlugin(obsidianDir, pluginId);

process.stdout.write(
  [
    `Installed ${pluginId} into:`,
    `  ${pluginDir}`,
    "",
    "Restart Obsidian or run 'Reload app without saving' from the command palette,",
    "then open Settings -> Community plugins -> Installed plugins.",
    "",
  ].join("\n"),
);

async function enablePlugin(obsidianDir, id) {
  const pluginsFile = path.join(obsidianDir, "community-plugins.json");
  let plugins = [];
  try {
    plugins = JSON.parse(await readFile(pluginsFile, "utf8"));
    if (!Array.isArray(plugins)) {
      plugins = [];
    }
  } catch {
    plugins = [];
  }

  if (!plugins.includes(id)) {
    plugins.push(id);
    await writeFile(pluginsFile, `${JSON.stringify(plugins, null, 2)}\n`);
  }
}
