import esbuild from "esbuild";
import process from "node:process";

const production = process.argv.includes("production");

await esbuild.build({
  banner: {
    js: "/* Stashwise Sync for Obsidian */",
  },
  bundle: true,
  entryPoints: ["src/main.ts"],
  external: ["obsidian"],
  format: "cjs",
  logLevel: "info",
  minify: production,
  outfile: "main.js",
  sourcemap: production ? false : "inline",
  target: "es2018",
  treeShaking: true,
});
