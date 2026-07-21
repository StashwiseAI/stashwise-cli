#!/usr/bin/env node
// Replay labeled probe prompts through the live search the hook uses, then
// report what each gating variant would admit.
//
//   npm run build && npm run calibrate
//   npm run calibrate -- --raw          # dump full score distributions
//
// Why this exists: the gate is tuned against cosine similarity, and cosine
// similarity is not comparable across queries. A vague prompt scores high
// against many mediocre items; a precise prompt scores low against the one
// item that actually answers it. Any constant picked by intuition will be
// wrong for one of those two shapes, so pick them against recorded reality
// and freeze the outcome into tests/hook.test.ts.
//
// Labels come from a live session on 2026-07-20 where each prompt's injected
// suggestions were compared against what the answer actually used.

import { StashwiseApi } from "../dist/api.js";
import { loadConfig } from "../dist/config.js";
import { filterSuggestions } from "../dist/hook.js";
import { getStoredToken } from "../dist/keychain.js";

// expect: what a correctly tuned gate should do with this prompt.
//   "inject" — at least one suggestion, and it must be genuinely useful
//   "silent" — nothing worth a slot; injecting here is noise
const PROBES = [
  {
    prompt: "how should I structure skills for an AI agent",
    expect: "silent",
    note: "Injected 2 Instagram videos about agent taxonomies. Neither informed the answer, which came from a loaded skill. The canonical false positive.",
  },
  {
    prompt: "how do I do keyword research without paying for semrush",
    expect: "inject",
    note: "OpenSEO save was cited as a direct recommendation.",
  },
  {
    prompt: "can I run deepseek on my own machine",
    expect: "inject",
    note: "DeepSeek V4 save changed the answer: flagged a model newer than the assistant's knowledge cutoff.",
  },
  {
    prompt: "how do people get their first users from Reddit?",
    expect: "inject",
    note: "Reddit cold start save was cited, though only confirmed the answer rather than shaping it. Weakest of the three positives.",
  },
  {
    prompt: "asdkfj qwerty zxcvbn plugh xyzzy frobnicate",
    expect: "silent",
    note: "Gibberish control. Anything admitted here is pure degenerate match.",
  },
  {
    prompt: "what is the capital city of France and how large is it",
    expect: "silent",
    note: "Coherent but unrelated to anything in the library. Guards against matching on generic question shape.",
  },
];

const K = 6;
const SCOPE = "all";

function mean(xs) {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function fmt(n) {
  return n.toFixed(3);
}

async function main() {
  const raw = process.argv.includes("--raw");
  const token = await getStoredToken();
  if (!token) {
    console.error("Not authenticated. Run: node dist/index.js auth");
    process.exit(1);
  }
  const api = new StashwiseApi(loadConfig());

  let pass = 0;
  for (const probe of PROBES) {
    const res = await api.search(token, probe.prompt, K, SCOPE);
    const results = res.results;

    console.log(`\n${"=".repeat(72)}`);
    console.log(`PROMPT   ${probe.prompt}`);
    console.log(`EXPECT   ${probe.expect}  — ${probe.note}`);

    if (raw) {
      console.log("\n  rank  score  kind     snip  title");
      results.forEach((r, i) => {
        console.log(
          `  ${String(i + 1).padStart(4)}  ${fmt(r.score)}  ${r.kind.padEnd(7)}  ` +
            `${String(r.snippet.trim().length).padStart(4)}  ${r.title.slice(0, 40)}`,
        );
      });
    }

    // Shape metrics on the results that could actually fill a slot: a
    // stub entity ranked first still tells us nothing, so it must not
    // anchor the distribution.
    const usable = results.filter((r) => r.snippet.trim().length >= 40);
    const scores = usable.map((r) => r.score);
    const top1 = scores[0] ?? 0;
    const rest = scores.slice(1);
    console.log(
      `\n  usable=${usable.length}/${results.length}  top1=${fmt(top1)}  ` +
        `mean(rest)=${fmt(mean(rest))}  prominence=${fmt(top1 - mean(rest))}`,
    );

    const kept = filterSuggestions(results, 0.45, new Set());
    const verdict = kept.length > 0 ? "inject" : "silent";
    const ok = verdict === probe.expect;
    if (ok) pass += 1;
    console.log(
      `  CURRENT  ${verdict.padEnd(7)} ${ok ? "PASS" : "FAIL"}  ` +
        `[${kept.map((r) => `${r.title.slice(0, 28)} ${fmt(r.score)}`).join(" | ")}]`,
    );
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log(`${pass}/${PROBES.length} probes match their label\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
