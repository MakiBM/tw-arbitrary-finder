#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

const fs = require("fs");
const path = require("path");
const { globSync } = require("glob");
const ignoreLib = require("ignore");
const { PREFIX_TABLES } = require("./tw-defaults");

// ---------- args ----------
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));

if (flags.has("--help") || flags.has("-h")) {
  console.log(`tw-arbitrary-finder

Finds Tailwind arbitrary-value classes (e.g. text-[13px], bg-[#abc123],
top-[calc(100%-1rem)]) so you can audit "magic" values in your codebase.

Usage:
  npx tw-arbitrary-finder [glob...] [options]

Examples:
  npx tw-arbitrary-finder
  npx tw-arbitrary-finder "src/**/*.{ts,tsx,jsx,vue,svelte,html}"
  npx tw-arbitrary-finder "app/**/*.tsx" --group --json > report.json

Options:
  --group        Group results by class instead of by file
  --json         Output machine-readable JSON
  --no-color     Disable ANSI colors
  --counts-only  Only print "<count>  <class>" lines, sorted desc
  --ignore <p>   Glob to ignore (repeatable). Defaults exclude node_modules,
                 .git, dist, build, .next, out, coverage.
  --no-gitignore Don't honor .gitignore files (honored by default).
  --all          Show all arbitrary classes (default: only those whose value
                 matches a Tailwind default token, e.g. text-[14px]->text-sm,
                 bg-[#ef4444]->bg-red-500, p-[16px]->p-4).
  -h, --help     Show this help
`);
  process.exit(0);
}

const useColor = !flags.has("--no-color") && process.stdout.isTTY;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c("2", s);
const bold = (s) => c("1", s);
const cyan = (s) => c("36", s);
const yellow = (s) => c("33", s);
const green = (s) => c("32", s);

// ---------- ignore globs ----------
const defaultIgnore = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/out/**",
  "**/coverage/**",
  "**/.turbo/**",
  "**/.cache/**",
];
const extraIgnore = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--ignore" && args[i + 1]) {
    extraIgnore.push(args[i + 1]);
    i++;
  }
}
const ignore = [...defaultIgnore, ...extraIgnore];

// ---------- patterns ----------
const DEFAULT_EXTS = "{js,jsx,ts,tsx,mjs,cjs,vue,svelte,astro,html,htm,mdx}";
const expandIfDir = (p) => {
  try {
    if (fs.statSync(p).isDirectory()) {
      return path.join(p, `**/*.${DEFAULT_EXTS}`);
    }
  } catch {}
  return p;
};
const patterns = positional.length
  ? positional.map(expandIfDir)
  : [`**/*.${DEFAULT_EXTS}`];

// ---------- the regex ----------
// Match Tailwind arbitrary values: an optional variant chain ending in `:`,
// an optional `!` important prefix, a utility prefix like `text-`, then a
// bracketed value `[...]`. The bracket body allows nested () and a few
// characters typical in CSS values: alphanumerics, units, hex, math ops,
// commas, slashes, underscores (Tailwind uses _ for spaces), dots, percent,
// quotes, colons (for css props), # and var(--x).
//
// We deliberately keep this permissive — false positives matter less than
// missing real classes. We strip surrounding quotes/JSX braces later.
const ARB_RE =
  /(?<![\w-])((?:[a-zA-Z0-9_\-/]+:)*!?-?[a-zA-Z][a-zA-Z0-9-]*-)\[([^\[\]\s'"`<>{}]+(?:\([^()]*\)[^\[\]\s'"`<>{}]*)*)\]/g;

// ---------- gitignore ----------
const useGitignore = !flags.has("--no-gitignore");
// Map of gitignore-root absolute dir -> ignore instance.
const gitignoreCache = new Map();
const loadGitignoreChain = (startDir) => {
  const chain = [];
  let dir = path.resolve(startDir);
  while (true) {
    if (gitignoreCache.has(dir)) {
      const cached = gitignoreCache.get(dir);
      if (cached) chain.push({ dir, ig: cached });
    } else {
      const gi = path.join(dir, ".gitignore");
      let ig = null;
      try {
        const content = fs.readFileSync(gi, "utf8");
        ig = ignoreLib().add(content);
      } catch {}
      gitignoreCache.set(dir, ig);
      if (ig) chain.push({ dir, ig });
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    // Stop at filesystem root or when we hit a .git directory boundary.
    if (fs.existsSync(path.join(dir, ".git"))) break;
    dir = parent;
  }
  return chain;
};
const isGitIgnored = (absFile) => {
  if (!useGitignore) return false;
  const chain = loadGitignoreChain(path.dirname(absFile));
  for (const { dir, ig } of chain) {
    const rel = path.relative(dir, absFile);
    if (!rel || rel.startsWith("..")) continue;
    if (ig.ignores(rel)) return true;
  }
  return false;
};

// ---------- collect files ----------
let files = [];
for (const p of patterns) {
  const matched = globSync(p, { ignore, nodir: true, dot: false, absolute: true });
  files = files.concat(matched);
}
files = [...new Set(files)];
if (useGitignore) files = files.filter((f) => !isGitIgnored(f));

if (!files.length) {
  console.error(dim(`No files matched: ${patterns.join(", ")}`));
  process.exit(0);
}

// ---------- default-token matcher ----------
// Strip variant chain ("md:hover:...") and modifiers ("!" / leading "-") so
// "md:hover:!-text" -> { variants: "md:hover:", neg: "-", bare: "text" }.
const splitPrefix = (prefix) => {
  const parts = prefix.split(":");
  const bareRaw = parts.pop();
  const variants = parts.length ? parts.join(":") + ":" : "";
  let rest = bareRaw;
  let bang = "";
  let neg = "";
  if (rest.startsWith("!")) { bang = "!"; rest = rest.slice(1); }
  if (rest.startsWith("-")) { neg = "-"; rest = rest.slice(1); }
  return { variants, bang, neg, bare: rest };
};

// Normalize an arbitrary value to a canonical lookup key.
// - underscores -> spaces (Tailwind syntax)
// - hex colors -> #rrggbb lowercase
// - lengths in rem/em -> px (assuming 16px root)
// - unitless numbers stay as-is (e.g. font-weight, opacity, z-index, order)
// - unitless decimals get a trailing "x" marker so leading-1.5 lookups work
const normalizeValue = (raw) => {
  let v = raw.replace(/_/g, " ").trim();
  // hex color
  let mHex = v.match(/^#([0-9a-fA-F]{3,8})$/);
  if (mHex) {
    let h = mHex[1].toLowerCase();
    if (h.length === 3) h = h.split("").map((ch) => ch + ch).join("");
    if (h.length === 4) {
      const expanded = h.split("").map((ch) => ch + ch).join("");
      return `#${expanded}`;
    }
    return `#${h}`;
  }
  // named colors / keywords
  const lower = v.toLowerCase();
  if (["transparent","currentcolor","inherit","white","black"].includes(lower)) {
    if (lower === "white") return "#ffffff";
    if (lower === "black") return "#000000";
    return lower;
  }
  // length with unit
  const mLen = v.match(/^(-?\d*\.?\d+)(px|rem|em|%|vh|vw|ms|s|em)$/);
  if (mLen) {
    let n = parseFloat(mLen[1]);
    let unit = mLen[2];
    if (unit === "rem") { n = n * 16; unit = "px"; }
    if (unit === "s")   { n = n * 1000; unit = "ms"; }
    // trim trailing zeros
    const num = Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(4)));
    return `${num}${unit}`;
  }
  // bare number → could be opacity / z-index / font-weight, or unitless ratio
  if (/^-?\d*\.?\d+$/.test(v)) {
    return v;
  }
  return v;
};

const lookupReplacement = (prefix, value) => {
  const { variants, bang, neg, bare } = splitPrefix(prefix);
  const tables = PREFIX_TABLES[bare];
  if (!tables) return null;
  let norm = normalizeValue(value);
  // For line-height: unitless multipliers like "1.5" map to "1.5x" entries.
  if (bare === "leading" && /^-?\d*\.?\d+$/.test(norm)) norm = `${norm}x`;
  for (const table of tables) {
    if (Object.prototype.hasOwnProperty.call(table, norm)) {
      const suffix = table[norm];
      const body = suffix === "" ? bare : `${bare}-${suffix}`;
      return `${variants}${bang}${neg}${body}`;
    }
  }
  return null;
};

const showAll = flags.has("--all");

// ---------- scan ----------
/** @type {{file:string,line:number,col:number,cls:string,prefix:string,value:string}[]} */
const hits = [];

for (const file of files) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  // Quick reject — no `-[` anywhere means no arbitrary values.
  if (!text.includes("-[")) continue;

  // Compute line offsets once per file for fast index→line conversion.
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  const idxToLineCol = (idx) => {
    // binary search
    let lo = 0,
      hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: idx - lineStarts[lo] + 1 };
  };

  ARB_RE.lastIndex = 0;
  let m;
  while ((m = ARB_RE.exec(text)) !== null) {
    const full = m[0];
    const prefix = m[1].replace(/-$/, ""); // drop trailing dash for display
    const value = m[2];
    const replacement = lookupReplacement(prefix, value);
    if (!showAll && !replacement) continue;
    const { line, col } = idxToLineCol(m.index);
    hits.push({
      file: path.relative(process.cwd(), file),
      line,
      col,
      cls: full,
      prefix,
      value,
      replacement,
    });
  }
}

// ---------- output ----------
if (flags.has("--json")) {
  process.stdout.write(JSON.stringify({ count: hits.length, hits }, null, 2));
  process.stdout.write("\n");
  process.exit(0);
}

if (!hits.length) {
  console.log(green("No arbitrary-value classes found. 🎉"));
  process.exit(0);
}

const arrow = (h) => (h.replacement ? `  ${dim("->")}  ${green(h.replacement)}` : "");
const clsByReplacement = new Map();
for (const h of hits) clsByReplacement.set(h.cls, h.replacement);

if (flags.has("--counts-only")) {
  const counts = new Map();
  for (const h of hits) counts.set(h.cls, (counts.get(h.cls) || 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [cls, n] of sorted) {
    const rep = clsByReplacement.get(cls);
    const suffix = rep ? `  ${dim("->")}  ${green(rep)}` : "";
    console.log(`${String(n).padStart(5)}  ${yellow(cls)}${suffix}`);
  }
  process.exit(0);
}

if (flags.has("--group")) {
  // Group by class name
  const byClass = new Map();
  for (const h of hits) {
    if (!byClass.has(h.cls)) byClass.set(h.cls, []);
    byClass.get(h.cls).push(h);
  }
  const sorted = [...byClass.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [cls, occurrences] of sorted) {
    const rep = clsByReplacement.get(cls);
    const suffix = rep ? `  ${dim("->")}  ${green(rep)}` : "";
    console.log(`${bold(yellow(cls))} ${dim(`(${occurrences.length})`)}${suffix}`);
    for (const h of occurrences) {
      console.log(`  ${cyan(h.file)}${dim(":")}${h.line}${dim(":")}${h.col}`);
    }
    console.log();
  }
} else {
  // Group by file (default)
  const byFile = new Map();
  for (const h of hits) {
    if (!byFile.has(h.file)) byFile.set(h.file, []);
    byFile.get(h.file).push(h);
  }
  for (const [file, hs] of byFile) {
    console.log(bold(cyan(file)) + dim(` (${hs.length})`));
    for (const h of hs) {
      console.log(
        `  ${dim(`${h.line}:${h.col}`.padEnd(8))}${yellow(h.cls)}${arrow(h)}`
      );
    }
    console.log();
  }
}

// ---------- summary ----------
const uniqueClasses = new Set(hits.map((h) => h.cls)).size;
const uniqueFiles = new Set(hits.map((h) => h.file)).size;
console.log(
  bold(
    `${hits.length} occurrence${hits.length === 1 ? "" : "s"} · ` +
      `${uniqueClasses} unique class${uniqueClasses === 1 ? "" : "es"} · ` +
      `${uniqueFiles} file${uniqueFiles === 1 ? "" : "s"}`
  )
);
