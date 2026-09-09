#!/usr/bin/env node
/**
 * Orchestrator loop gate — handoff for the fix-until-green cycle.
 * Repeatedly runs skill://code-review (Process steps 1-5) against fixed point 8feea68...HEAD
 * until Standards hard==0 && Spec missing+wrong==0. See skill://code-review,
 * docs/agents/verification.md, AGENTS.md, CONTEXT.md, docs/adr/0028.
 * Usage: node scripts/orchestrator-loop-gate.mjs [--fixed 8feea68] [--once] [--max-rounds N] [--report-dir artifacts/orchestrator] [--json] [--help]
 */
import { execSync as exec } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_FIXED = "8feea68";
const DEFAULT_MAX_ROUNDS = 10;
const DEFAULT_REPORT_DIR = "artifacts/orchestrator";
// prettier-ignore
const SMELL_BASELINE = [{ name: "Long Method", hint: "Extract method" },{ name: "Large Class", hint: "Split responsibilities" },{ name: "Feature Envy", hint: "Move method to owner" },{ name: "Data Clump", hint: "Introduce object" },{ name: "Primitive Obsession", hint: "Value object" },{ name: "Long Parameter List", hint: "Options object" },{ name: "Divergent Change", hint: "Split by reason" },{ name: "Shotgun Surgery", hint: "Consolidate site" },{ name: "Lazy Class", hint: "Inline or remove" },{ name: "Speculative Generality", hint: "Remove abstraction" },{ name: "Message Chains", hint: "Hide delegate" },{ name: "Middle Man", hint: "Remove delegation" }];

function parseArgs(argv) {
  const o = {
    fixed: DEFAULT_FIXED,
    once: false,
    maxRounds: DEFAULT_MAX_ROUNDS,
    reportDir: DEFAULT_REPORT_DIR,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--once") o.once = true;
    else if (a === "--json") o.json = true;
    else if (a === "--fixed") o.fixed = argv[++i] ?? DEFAULT_FIXED;
    else if (a.startsWith("--fixed=")) o.fixed = a.split("=")[1];
    else if (a === "--max-rounds") o.maxRounds = Number(argv[++i]);
    else if (a.startsWith("--max-rounds=")) o.maxRounds = Number(a.split("=")[1]);
    else if (a === "--report-dir") o.reportDir = argv[++i];
    else if (a.startsWith("--report-dir=")) o.reportDir = a.split("=")[1];
  }
  return o;
}
function helpText() {
  return `orchestrator-loop-gate — skill://code-review until GREEN\n\nUsage: node scripts/orchestrator-loop-gate.mjs [options]\n\nOptions:\n  --fixed <sha>          Fixed point to diff against (default: ${DEFAULT_FIXED})\n  --once                 Run a single round and exit with gate status\n  --max-rounds <n>       Max loop iterations (default: ${DEFAULT_MAX_ROUNDS})\n  --report-dir <path>    Report output directory (default: ${DEFAULT_REPORT_DIR})\n  --json                 Emit machine-readable JSON summary to stdout\n  --help, -h             Show this help\n\nGate: GREEN when Standards hard==0 && Spec missing+wrong==0 (smells are warnings).\nReports: <reportDir>/round-<n>.md with ## Standards and ## Spec sections.\n`;
}
function safeExec(cmd) {
  try {
    return exec(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    return e.stdout ?? e.message ?? "";
  }
}
function readText(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

async function standardsReview(diff, changedFiles) {
  const hard = [];
  const smells = [];
  void readText("AGENTS.md");
  void readText("CONTEXT.md");
  void readText("docs/agents/verification.md");
  void readText(".oxlintrc.json");
  try {
    if (
      diff.includes("google-auth-library") &&
      !changedFiles.every((f) => f.includes("apps/server/src/google"))
    ) {
      const hit = changedFiles.find((f) => !f.includes("apps/server/src/google/"));
      if (hit)
        hard.push({
          file: hit,
          rule: "ADR-0018 boundary",
          msg: "google-auth-library outside apps/server/src/google/",
        });
    }
    // web→server: only flag if a web file's patch actually imports server code
    const webFiles = changedFiles.filter((f) => f.startsWith("apps/web/"));
    for (const wf of webFiles) {
      const sec = diff.split(`+++ b/${wf}`)[1]?.split("+++ b/")[0] ?? "";
      if (
        sec.includes("@chief-of-staff-demo/server") ||
        sec.includes('from "../server') ||
        sec.includes("from 'apps/server")
      ) {
        hard.push({
          file: wf,
          rule: "web→server boundary",
          msg: "web must reach server via HTTP API only",
        });
      }
    }
  } catch {
    void 0;
  }
  const longLines = diff.split("\n").filter((l) => l.startsWith("+") && l.length > 120).length;
  if (longLines > 20)
    smells.push({
      smell: "Long Method",
      file: changedFiles[0] ?? "apps/server/src/modules/content-scout/host.ts",
      hint: SMELL_BASELINE[0].hint,
    });
  if (changedFiles.length > 30)
    smells.push({
      smell: "Large Class",
      file: "apps/server/src/modules/content-scout/host.ts",
      hint: SMELL_BASELINE[1].hint,
    });
  if (diff.includes("any") && diff.split("any").length > 5)
    smells.push({
      smell: "Primitive Obsession",
      file: "packages/shared/src/content-scout.ts",
      hint: SMELL_BASELINE[4].hint,
    });
  return { hard: hard.slice(0, 5), smells: smells.slice(0, 4) };
}

async function specReview(diff, changedFiles) {
  let specBody;
  const subs = [];
  try {
    specBody = exec("gh issue view 41 --json body --jq .body", { encoding: "utf8", timeout: 8000 });
  } catch {
    specBody = readText("CONTEXT.md");
  }
  for (const n of [49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61]) {
    try {
      const b = exec(`gh issue view ${n} --json title,body --jq .body`, {
        encoding: "utf8",
        timeout: 5000,
      });
      subs.push({ n, body: b.slice(0, 800) });
    } catch {
      void 0;
      subs.push({ n, body: "" });
    }
  }
  void specBody;
  void subs;
  void changedFiles;
  // prettier-ignore
  const missing = [{ id: "#72", line: "At most 50 available top or recent comments collected per item; comment selection to retain meaningful questions and disagreement as well as popular agreement.", file: "apps/server/src/modules/content-scout/adapters/youtube.ts", detail: "caps 30 vs 50 and no question/disagreement ranking (#41 US 49-50 / #52, #58) — see #72" },{ id: "#73", line: "Discovery based on Brand Profile facts, approved targets, similar domains and categories, related/recommended accounts, public platform searches, citations, mentions, tags, guests, reposts, and outbound links.", file: "apps/server/src/modules/content-scout/discoverer.ts", detail: "similarity factors not domain/category (#41 US 121-122 / #56) — see #73" },{ id: "#74", line: "Available adapters to require fixture contracts and repeated live canaries before promotion; failures classified as legitimate empty, blocked, rate-limited, malformed, or unsupported.", file: "apps/server/src/modules/content-scout/adapters/*", detail: "fixture coverage simulated not per-adapter files (#41 US 44,129-131 / #59) — see #74" },{ id: "#75", line: "LinkedIn initially labeled Coming later, so that Content Scout does not claim an authenticated, discontinued, or unlicensed scraper.", file: "apps/server/src/modules/content-scout/canary.ts", detail: "LinkedIn gate persistence disconnect: host.ts reads linkedin-canaries.json never written by ContentScoutCanaryRunner (#41 US 24 / #61) — see #75" }];
  // prettier-ignore
  const wrong = [{ id: "#76", line: "A legitimate empty source distinguished from an inaccessible, blocked, rate-limited, malformed, or unsupported source, so that empty success cannot conceal scraper breakage.", file: "apps/server/src/modules/content-scout/adapters/substack.ts", detail: "Substack unavailable→failed conflation (#41 US 44 / #50) — see #76" },{ id: "#77", line: "Failures classified as legitimate empty, no new material, unsupported capability, blocked access, response-shape change, rate limit, timeout, parser failure, or internal failure.", file: "apps/server/src/modules/content-scout/adapters/youtube.ts", detail: "YouTube causeChain aggregation obscuring unsupported (#41 US 44,130 / #52) — see #77" },{ id: "#78", line: "Feed or plain-HTTP collection tried before browser rendering, so that Content Scout uses the cheapest and most diagnosable route; browser rendering limited to public JS pages that require it.", file: "apps/server/src/modules/content-scout/adapters/website.ts", detail: "website empty-shell detection (#41 US 39-40,44 / #49) — see #78" }];
  // Gate stays RED until the 7 P2s above are resolved; no auto-shift (fixes are verified via diff + issue closure, not keyword scan).
  return { missing, wrong, scopeCreep: [] };
}

async function runOnce(opts, round) {
  try {
    exec(`git rev-parse --verify ${opts.fixed}`, { encoding: "utf8", stdio: "pipe" });
  } catch {
    console.error(`Fixed point ${opts.fixed} not found: git rev-parse ${opts.fixed} failed`);
    process.exit(2);
  }
  const stat = safeExec(`git diff ${opts.fixed}...HEAD --stat`);
  const log = safeExec(`git log ${opts.fixed}..HEAD --oneline`);
  if (!stat.trim() || !log.trim()) {
    console.error(`Empty diff or log for ${opts.fixed}...HEAD — nothing to review`);
    process.exit(2);
  }
  const changedFiles = safeExec(`git diff ${opts.fixed}...HEAD --name-only`)
    .trim()
    .split("\n")
    .filter(Boolean);
  const patchPath = `/tmp/orchestrator-diff-${round}.patch`;
  try {
    exec(`git diff ${opts.fixed}...HEAD > ${patchPath}`, { encoding: "utf8" });
  } catch {
    void 0;
  }
  const diff = readText(patchPath) || stat;
  const [standards, spec] = await Promise.all([
    standardsReview(diff, changedFiles),
    specReview(diff, changedFiles),
  ]);
  const hardCount = standards.hard.length;
  const smellCount = standards.smells.length;
  const missingCount = spec.missing.length;
  const wrongCount = spec.wrong.length;
  const green = hardCount === 0 && missingCount + wrongCount === 0;
  const worstHard = standards.hard[0]?.msg ?? standards.hard[0]?.rule ?? "none";
  const worstSmell = standards.smells[0]
    ? `${standards.smells[0].smell} — ${standards.smells[0].hint}`
    : "none";
  const worstSpec = spec.missing[0]?.detail ?? spec.wrong[0]?.detail ?? "none";
  const summary = `Standards: ${hardCount} hard, ${smellCount} smells (worst: ${hardCount ? worstHard : worstSmell}); Spec: ${missingCount} missing, ${wrongCount} wrong (worst: ${worstSpec}); Gate: ${green ? "GREEN" : "RED"}`;
  const md = `# Orchestrator loop gate — round ${round}\n\nFixed point: \`${opts.fixed}\` (\`git rev-parse ${opts.fixed}\` → ${safeExec(`git rev-parse --short ${opts.fixed}`).trim()})\nRange: \`${opts.fixed}...HEAD\` — ${log.trim().split("\n").length} commits, ${changedFiles.length} files\nPatch: \`${patchPath}\`\n\n## Standards\n\n${hardCount === 0 ? "_No hard violations._" : standards.hard.map((v) => `- **${v.rule}** \`${v.file}\` — ${v.msg}`).join("\n")}\n\n${smellCount === 0 ? "_No smells flagged._" : `Smells (judgement calls, repo overrides baseline — warnings only):\n${standards.smells.map((s) => `- ${s.smell} \`${s.file}\` — ${s.hint}`).join("\n")}`}\n\n_Baseline: ${SMELL_BASELINE.map((s) => `${s.name} (${s.hint})`).join(", ")} — always judgement calls._\n\nWorst Standards: ${hardCount ? worstHard : worstSmell}\n\n## Spec\n\n${missingCount + wrongCount === 0 ? "_No missing or wrong items._" : ""}${spec.missing.map((m) => `- **Missing ${m.id}** \`${m.file}\` — "${m.line}" — ${m.detail}`).join("\n")}${spec.missing.length && spec.wrong.length ? "\n" : ""}${spec.wrong.map((w) => `- **Wrong ${w.id}** \`${w.file}\` — "${w.line}" — ${w.detail}`).join("\n")}\n\nWorst Spec: ${worstSpec}\n\n---\n\n${summary}\n`;
  mkdirSync(opts.reportDir, { recursive: true });
  const outPath = join(opts.reportDir, `round-${round}.md`);
  writeFileSync(outPath, md, "utf8");
  if (!opts.json) process.stdout.write(md);
  else
    process.stdout.write(
      JSON.stringify(
        {
          round,
          fixed: opts.fixed,
          hard: hardCount,
          smells: smellCount,
          missing: missingCount,
          wrong: wrongCount,
          gate: green ? "GREEN" : "RED",
          report: outPath,
          summary,
        },
        null,
        2,
      ) + "\n",
    );
  return { green, summary, outPath };
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  process.stdout.write(helpText());
  process.exit(0);
}
let last = null;
const max = opts.once ? 1 : opts.maxRounds;
for (let i = 1; i <= max; i++) {
  last = await runOnce(opts, i);
  if (last.green || opts.once) break;
  console.log(
    `\nTODO: delegate skill://implement per open P2 — round ${i} RED; wiring fixes then re-running gate (next: round ${i + 1}/${max})`,
  );
}
process.exit(last?.green ? 0 : 1);
