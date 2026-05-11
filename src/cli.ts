#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { globSync } from "glob";
import ignoreLib from "ignore";
import {
  NAMESPACES,
  NAMESPACE_ALIASES,
  NamespaceKey,
  PREFIX_RULES,
  Rule,
  Table,
  spacingBase,
} from "./tw-defaults";

// ---------- args ----------
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));

if (flags.has("--help") || flags.has("-h")) {
  console.log(`tw-arbitrary-finder

Finds Tailwind v4 arbitrary-value classes (e.g. text-[13px], bg-[#abc123],
top-[calc(100%-1rem)]) and suggests the matching default token.

Defaults are read from your project's installed tailwindcss/theme.css plus
any @theme/:root declarations in your own *.css files. No theme values are
hardcoded — if tailwindcss isn't installed in the search path, the tool
exits with an error.

Usage:
  npx tw-arbitrary-finder [glob|dir...] [options]

Options:
  --group        Group results by class instead of by file
  --json         Output machine-readable JSON
  --no-color     Disable ANSI colors
  --counts-only  Only print "<count>  <class>" lines, sorted desc
  --ignore <p>   Glob to ignore (repeatable).
  --no-gitignore Don't honor .gitignore files (honored by default).
  --all          Show every arbitrary class, even ones with no replacement.
  --theme <file> Extra CSS file to read theme tokens from (repeatable).
  --no-theme     Skip user CSS theme scanning (still loads tailwindcss).
  --show-theme   Print every theme token that was loaded and exit.
  --round        Also suggest the NEAREST default token in orange (~>).
  -h, --help     Show this help
`);
  process.exit(0);
}

const useColor = !flags.has("--no-color") && process.stdout.isTTY;
const c = (code: string, s: string): string =>
  useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
const dim = (s: string): string => c("2", s);
const bold = (s: string): string => c("1", s);
const cyan = (s: string): string => c("36", s);
const yellow = (s: string): string => c("33", s);
const green = (s: string): string => c("32", s);
const red = (s: string): string => c("31", s);
const orange = (s: string): string =>
  useColor ? `\x1b[38;5;208m${s}\x1b[0m` : s;

// ---------- ignore globs ----------
const defaultIgnore: string[] = [
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
const extraIgnore: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--ignore" && args[i + 1]) {
    extraIgnore.push(args[i + 1]);
    i++;
  }
}
const ignore = [...defaultIgnore, ...extraIgnore];

// ---------- patterns ----------
const DEFAULT_EXTS = "{js,jsx,ts,tsx,mjs,cjs,vue,svelte,astro,html,htm,mdx}";
const expandIfDir = (p: string): string => {
  try {
    if (fs.statSync(p).isDirectory()) {
      return path.join(p, `**/*.${DEFAULT_EXTS}`);
    }
  } catch {}
  return p;
};
const patterns: string[] = positional.length
  ? positional.map(expandIfDir)
  : [`**/*.${DEFAULT_EXTS}`];

// Derive search roots (used by gitignore, theme loader, and tailwindcss
// resolution) from the input patterns.
const searchRoots = (() => {
  const roots = new Set<string>();
  for (const p of patterns) {
    const cleanRoot = p.split("**")[0].replace(/[\\/]$/, "");
    if (cleanRoot && fs.existsSync(cleanRoot)) {
      try {
        const stat = fs.statSync(cleanRoot);
        roots.add(stat.isDirectory() ? cleanRoot : path.dirname(cleanRoot));
      } catch {}
    }
  }
  if (!roots.size) roots.add(process.cwd());
  return [...roots];
})();

// ---------- ARB_RE ----------
// Matches Tailwind arbitrary-value utility classes. The trailing
// (?!(?:\/[\w-]+)?:) rejects arbitrary VARIANT selectors (`data-[…]:`,
// `group-data-[…]/name:`) which end with `]:` or `]/name:`.
const ARB_RE =
  /(?<![\w-])((?:[a-zA-Z0-9_\-/]+(?:\[[^\]]*\])?(?:\/[\w-]+)?:)*!?-?[a-zA-Z][a-zA-Z0-9-]*-)\[([^\[\]\s'"`<>{}]+(?:\([^()]*\)[^\[\]\s'"`<>{}]*)*)\](?!(?:\/[\w-]+)?:)/g;

// ---------- gitignore ----------
const useGitignore = !flags.has("--no-gitignore");
type Ignore = ReturnType<typeof ignoreLib>;
const gitignoreCache = new Map<string, Ignore | null>();
const loadGitignoreChain = (
  startDir: string,
): { dir: string; ig: Ignore }[] => {
  const chain: { dir: string; ig: Ignore }[] = [];
  let dir = path.resolve(startDir);
  while (true) {
    if (gitignoreCache.has(dir)) {
      const cached = gitignoreCache.get(dir);
      if (cached) chain.push({ dir, ig: cached });
    } else {
      const gi = path.join(dir, ".gitignore");
      let ig: Ignore | null = null;
      try {
        const content = fs.readFileSync(gi, "utf8");
        ig = ignoreLib().add(content);
      } catch {}
      gitignoreCache.set(dir, ig);
      if (ig) chain.push({ dir, ig });
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    if (fs.existsSync(path.join(dir, ".git"))) break;
    dir = parent;
  }
  return chain;
};
const isGitIgnored = (absFile: string): boolean => {
  if (!useGitignore) return false;
  const chain = loadGitignoreChain(path.dirname(absFile));
  for (const { dir, ig } of chain) {
    const rel = path.relative(dir, absFile);
    if (!rel || rel.startsWith("..")) continue;
    if (ig.ignores(rel)) return true;
  }
  return false;
};

// ---------- oklch -> hex ----------
// Tailwind v4 theme uses oklch(). We convert to sRGB hex so values can be
// matched against authored hex arbitrary classes.
const oklchToHex = (L: number, C: number, h: number): string => {
  const labL = L / 100;
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  let l = labL + 0.3963377774 * a + 0.2158037573 * b;
  let m = labL - 0.1055613458 * a - 0.0638541728 * b;
  let s = labL - 0.0894841775 * a - 1.291485548 * b;
  l = l ** 3;
  m = m ** 3;
  s = s ** 3;
  let r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  let g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  let bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const toSrgb = (x: number): number => {
    if (!Number.isFinite(x) || x <= 0) return 0;
    if (x >= 1) return 1;
    return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  };
  const hex = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(toSrgb(n) * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(bl)}`;
};

const parseOklch = (raw: string): string | null => {
  const m = raw.match(
    /^oklch\(\s*([\d.]+)%?\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*[\d.]+%?\s*)?\)$/i,
  );
  if (!m) return null;
  return oklchToHex(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
};

// ---------- value normalization ----------
const expandHex = (h: string): string => {
  let s = h.toLowerCase();
  if (s.length === 3) s = s.split("").map((ch) => ch + ch).join("");
  if (s.length === 4) s = s.split("").map((ch) => ch + ch).join("");
  return `#${s}`;
};

const normalizeValue = (raw: string): string => {
  const v = raw.replace(/_/g, " ").trim();
  const mHex = v.match(/^#([0-9a-fA-F]{3,8})$/);
  if (mHex) return expandHex(mHex[1]);
  const oklch = parseOklch(v);
  if (oklch) return oklch;
  const lower = v.toLowerCase();
  if (lower === "white") return "#ffffff";
  if (lower === "black") return "#000000";
  if (["transparent", "currentcolor", "inherit"].includes(lower)) return lower;
  const mLen = v.match(/^(-?\d*\.?\d+)(px|rem|em|%|vh|vw|ms|s)$/);
  if (mLen) {
    let n = parseFloat(mLen[1]);
    let unit = mLen[2];
    if (unit === "rem") {
      n = n * 16;
      unit = "px";
    }
    if (unit === "s") {
      n = n * 1000;
      unit = "ms";
    }
    const num = Number.isInteger(n)
      ? String(n)
      : String(parseFloat(n.toFixed(4)));
    return `${num}${unit}`;
  }
  return v;
};

// ---------- tailwindcss resolution ----------
const findTailwindThemeCss = (): string => {
  for (const root of searchRoots) {
    let dir = path.resolve(root);
    while (true) {
      const p = path.join(dir, "node_modules", "tailwindcss", "theme.css");
      if (fs.existsSync(p)) return p;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  console.error(
    red(
      "Error: tailwindcss not found in node_modules. " +
        "Install it (npm i tailwindcss) and re-run.",
    ),
  );
  process.exit(1);
};

// ---------- theme loading ----------
interface ThemeAddition {
  ns: NamespaceKey;
  name: string;
  normValue: string;
  rawValue: string;
  source: string;
}

const loadThemeFromCss = (
  file: string,
  additions: ThemeAddition[],
): void => {
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  content = content.replace(/\/\*[\s\S]*?\*\//g, "");
  const declRe = /--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;
  const aliasesDesc = Object.keys(NAMESPACE_ALIASES).sort(
    (a, b) => b.length - a.length,
  );
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(content)) !== null) {
    const fullName = m[1];
    const rawValue = m[2].trim();
    // v4: bare `--spacing: 0.25rem;` sets the spacing multiplier.
    if (fullName === "spacing") {
      const norm = normalizeValue(rawValue);
      const mPx = norm.match(/^(-?\d*\.?\d+)px$/);
      if (mPx) spacingBase.px = parseFloat(mPx[1]);
      continue;
    }
    // Skip companion declarations like `--text-sm--line-height`.
    if (fullName.includes("--")) continue;
    for (const alias of aliasesDesc) {
      if (fullName.startsWith(`${alias}-`)) {
        const name = fullName.slice(alias.length + 1);
        if (!name) break;
        const nsKey = NAMESPACE_ALIASES[alias];
        const table: Table = NAMESPACES[nsKey];
        const normValue = normalizeValue(rawValue);
        // First writer wins per value, but later declarations (user CSS over
        // framework defaults) override the name-by-namespace lookups since we
        // load framework first.
        if (!Object.prototype.hasOwnProperty.call(table, normValue)) {
          table[normValue] = name;
        }
        const varKey = `var(--${fullName})`;
        if (!Object.prototype.hasOwnProperty.call(table, varKey)) {
          table[varKey] = name;
        }
        additions.push({
          ns: nsKey,
          name,
          normValue,
          rawValue,
          source: file,
        });
        break;
      }
    }
  }
};

const themeAdditions: ThemeAddition[] = [];

// Framework defaults first.
const tailwindTheme = findTailwindThemeCss();
loadThemeFromCss(tailwindTheme, themeAdditions);

// User CSS overrides next.
const useUserTheme = !flags.has("--no-theme");
const customThemeFiles: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--theme" && args[i + 1]) {
    customThemeFiles.push(args[i + 1]);
    i++;
  }
}
if (useUserTheme) {
  const userCssFiles = new Set<string>();
  for (const root of searchRoots) {
    for (const f of globSync(path.join(root, "**/*.css"), {
      ignore,
      nodir: true,
      absolute: true,
    })) {
      if (useGitignore && isGitIgnored(f)) continue;
      userCssFiles.add(f);
    }
  }
  for (const f of customThemeFiles) {
    try {
      userCssFiles.add(path.resolve(f));
    } catch {}
  }
  for (const f of userCssFiles) loadThemeFromCss(f, themeAdditions);
}

// Ensure --spacing has a value (Tailwind v4 ships `--spacing: 0.25rem`).
if (spacingBase.px == null) spacingBase.px = 4;

// ---------- collect files ----------
let files: string[] = [];
for (const p of patterns) {
  const matched = globSync(p, {
    ignore,
    nodir: true,
    dot: false,
    absolute: true,
  });
  files = files.concat(matched);
}
files = [...new Set(files)];
if (useGitignore) files = files.filter((f) => !isGitIgnored(f));

if (!files.length) {
  console.error(dim(`No files matched: ${patterns.join(", ")}`));
  process.exit(0);
}

// ---------- prefix splitting ----------
interface PrefixParts {
  variants: string;
  bang: string;
  neg: string;
  bare: string;
}
const splitPrefix = (prefix: string): PrefixParts => {
  const parts = prefix.split(":");
  const bareRaw = parts.pop() ?? "";
  const variants = parts.length ? parts.join(":") + ":" : "";
  let rest = bareRaw;
  let bang = "";
  let neg = "";
  if (rest.startsWith("!")) {
    bang = "!";
    rest = rest.slice(1);
  }
  if (rest.startsWith("-")) {
    neg = "-";
    rest = rest.slice(1);
  }
  return { variants, bang, neg, bare: rest };
};

// ---------- matching ----------
const NUM_UNIT_RE = /^(-?\d*\.?\d+)([a-z%]*)$/;

// Format a numeric suffix the way Tailwind writes it (drop trailing zeros,
// keep `.5` halves).
const fmtSpacingSuffix = (n: number): string =>
  Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(3)));

interface Replacement {
  replacement: string;
  approx: boolean;
}

const buildReplacement = (
  parts: PrefixParts,
  suffix: string,
): string => {
  const { variants, bang, neg, bare } = parts;
  const body = suffix === "" ? bare : `${bare}-${suffix}`;
  return `${variants}${bang}${neg}${body}`;
};

const distance = (a: string, b: string): number => {
  if (a.startsWith("#") && b.startsWith("#") && a.length === 7 && b.length === 7) {
    const rgb = (h: string): [number, number, number] => [
      parseInt(h.slice(1, 3), 16),
      parseInt(h.slice(3, 5), 16),
      parseInt(h.slice(5, 7), 16),
    ];
    const [r1, g1, b1] = rgb(a);
    const [r2, g2, b2] = rgb(b);
    return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
  }
  const m1 = a.match(NUM_UNIT_RE);
  const m2 = b.match(NUM_UNIT_RE);
  if (m1 && m2 && m1[2] === m2[2]) {
    return Math.abs(parseFloat(m1[1]) - parseFloat(m2[1]));
  }
  return Infinity;
};

const acceptApprox = (value: string, dist: number): boolean => {
  if (!Number.isFinite(dist)) return false;
  if (value.startsWith("#")) return dist <= 40;
  const m = value.match(NUM_UNIT_RE);
  if (!m) return false;
  const unit = m[2];
  const n = Math.abs(parseFloat(m[1]));
  if (unit === "px") return dist <= Math.max(4, n * 0.25);
  if (unit === "ms") return dist <= Math.max(50, n * 0.3);
  if (unit === "em" || unit === "%") return dist <= Math.max(0.05, n * 0.25);
  if (unit === "") return dist <= Math.max(1, n * 0.1);
  return dist <= n * 0.25;
};

// Try a single rule against a normalized value. Returns the suffix on hit.
const applyRule = (
  rule: Rule,
  norm: string,
  bare: string,
): { suffix: string; approx: false } | null => {
  if (rule.kind === "theme") {
    const table = NAMESPACES[rule.ns];
    let key = norm;
    if (bare === "leading" && /^-?\d*\.?\d+$/.test(norm)) key = `${norm}x`;
    if (Object.prototype.hasOwnProperty.call(table, key)) {
      return { suffix: table[key], approx: false };
    }
    return null;
  }
  if (rule.kind === "spacing") {
    const mPx = norm.match(/^(-?\d*\.?\d+)px$/);
    if (!mPx) return null;
    const px = parseFloat(mPx[1]);
    if (px === 0) return { suffix: "0", approx: false };
    if (px === 1) return { suffix: "px", approx: false };
    const base = spacingBase.px ?? 4;
    const n = px / base;
    // Accept whole-number or .5 multiples.
    if (Math.abs(n - Math.round(n * 2) / 2) < 1e-6) {
      return { suffix: fmtSpacingSuffix(Math.round(n * 2) / 2), approx: false };
    }
    return null;
  }
  if (rule.kind === "integer-px") {
    const mPx = norm.match(/^(-?\d+)px$/);
    if (!mPx) return null;
    const n = parseInt(mPx[1], 10);
    return { suffix: String(n), approx: false };
  }
  if (rule.kind === "integer") {
    if (/^-?\d+$/.test(norm)) return { suffix: norm, approx: false };
    return null;
  }
  if (rule.kind === "ms") {
    const mMs = norm.match(/^(-?\d+)ms$/);
    if (mMs) return { suffix: mMs[1], approx: false };
    return null;
  }
  if (rule.kind === "percent") {
    const mPct = norm.match(/^(-?\d+)%$/);
    if (mPct) return { suffix: mPct[1], approx: false };
    if (/^-?\d+$/.test(norm)) return { suffix: norm, approx: false };
    return null;
  }
  return null;
};

// Approximate-match within a single rule.
const approxRule = (
  rule: Rule,
  norm: string,
  bare: string,
): { suffix: string; dist: number } | null => {
  if (rule.kind === "theme") {
    const table = NAMESPACES[rule.ns];
    let key = norm;
    if (bare === "leading" && /^-?\d*\.?\d+$/.test(norm)) key = `${norm}x`;
    let best: { suffix: string; dist: number } | null = null;
    for (const k of Object.keys(table)) {
      const d = distance(key, k);
      if (best === null || d < best.dist) best = { suffix: table[k], dist: d };
    }
    return best;
  }
  if (rule.kind === "spacing") {
    const mPx = norm.match(/^(-?\d*\.?\d+)px$/);
    if (!mPx) return null;
    const px = parseFloat(mPx[1]);
    const base = spacingBase.px ?? 4;
    const rounded = Math.round((px / base) * 2) / 2;
    const dist = Math.abs(px - rounded * base);
    return { suffix: fmtSpacingSuffix(rounded), dist };
  }
  if (rule.kind === "integer-px") {
    const mPx = norm.match(/^(-?\d*\.?\d+)px$/);
    if (!mPx) return null;
    const n = Math.round(parseFloat(mPx[1]));
    return { suffix: String(n), dist: Math.abs(parseFloat(mPx[1]) - n) };
  }
  if (rule.kind === "integer") {
    const m = norm.match(/^(-?\d*\.?\d+)$/);
    if (!m) return null;
    const n = Math.round(parseFloat(m[1]));
    return { suffix: String(n), dist: Math.abs(parseFloat(m[1]) - n) };
  }
  if (rule.kind === "ms") {
    const m = norm.match(/^(-?\d*\.?\d+)ms$/);
    if (!m) return null;
    const n = Math.round(parseFloat(m[1]));
    return { suffix: String(n), dist: Math.abs(parseFloat(m[1]) - n) };
  }
  if (rule.kind === "percent") {
    const m = norm.match(/^(-?\d*\.?\d+)%?$/);
    if (!m) return null;
    const n = Math.round(parseFloat(m[1]));
    return { suffix: String(n), dist: Math.abs(parseFloat(m[1]) - n) };
  }
  return null;
};

const lookupReplacement = (
  prefix: string,
  value: string,
  allowApprox: boolean,
): Replacement | null => {
  const parts = splitPrefix(prefix);
  const rules = PREFIX_RULES[parts.bare];
  if (!rules) return null;
  const norm = normalizeValue(value);
  for (const rule of rules) {
    const hit = applyRule(rule, norm, parts.bare);
    if (hit) return { replacement: buildReplacement(parts, hit.suffix), approx: false };
  }
  if (!allowApprox) return null;
  let best: { suffix: string; dist: number } | null = null;
  for (const rule of rules) {
    const a = approxRule(rule, norm, parts.bare);
    if (a && (best === null || a.dist < best.dist)) best = a;
  }
  if (best && acceptApprox(norm, best.dist)) {
    return { replacement: buildReplacement(parts, best.suffix), approx: true };
  }
  return null;
};

const showAll = flags.has("--all");
const roundNearest = flags.has("--round");

// ---------- --show-theme ----------
if (flags.has("--show-theme")) {
  if (!themeAdditions.length) {
    console.log(dim("No theme tokens loaded."));
  } else {
    const bySource = new Map<string, ThemeAddition[]>();
    for (const a of themeAdditions) {
      if (!bySource.has(a.source)) bySource.set(a.source, []);
      bySource.get(a.source)!.push(a);
    }
    for (const [src, items] of bySource) {
      console.log(
        bold(cyan(path.relative(process.cwd(), src))) +
          dim(` (${items.length})`),
      );
      for (const a of items) {
        console.log(
          `  ${dim(a.ns + "-")}${yellow(a.name)} ${dim("=")} ${a.rawValue}`,
        );
      }
    }
    console.log(
      dim(
        `\nspacing base: ${spacingBase.px}px · ${themeAdditions.length} tokens`,
      ),
    );
  }
  process.exit(0);
}

// ---------- scan ----------
interface Hit {
  file: string;
  line: number;
  col: number;
  cls: string;
  prefix: string;
  value: string;
  replacement: string | null;
  approx: boolean;
}
const hits: Hit[] = [];

for (const file of files) {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (!text.includes("-[")) continue;

  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  const idxToLineCol = (idx: number): { line: number; col: number } => {
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
  let m: RegExpExecArray | null;
  while ((m = ARB_RE.exec(text)) !== null) {
    const full = m[0];
    const prefix = m[1].replace(/-$/, "");
    const value = m[2];
    const r = lookupReplacement(prefix, value, roundNearest);
    if (!showAll && !r) continue;
    const { line, col } = idxToLineCol(m.index);
    hits.push({
      file: path.relative(process.cwd(), file),
      line,
      col,
      cls: full,
      prefix,
      value,
      replacement: r ? r.replacement : null,
      approx: r ? r.approx : false,
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

const fmtRep = (
  rep: string | null | undefined,
  approx: boolean | undefined,
): string => {
  if (!rep) return "";
  const sep = approx ? dim("~>") : dim("->");
  const color = approx ? orange : green;
  return `  ${sep}  ${color(rep)}`;
};
const arrow = (h: Hit): string => fmtRep(h.replacement, h.approx);
const repByCls = new Map<string, { rep: string | null; approx: boolean }>();
for (const h of hits) repByCls.set(h.cls, { rep: h.replacement, approx: h.approx });

if (flags.has("--counts-only")) {
  const counts = new Map<string, number>();
  for (const h of hits) counts.set(h.cls, (counts.get(h.cls) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [cls, n] of sorted) {
    const entry = repByCls.get(cls);
    console.log(
      `${String(n).padStart(5)}  ${yellow(cls)}${fmtRep(entry?.rep, entry?.approx)}`,
    );
  }
  process.exit(0);
}

if (flags.has("--group")) {
  const byClass = new Map<string, Hit[]>();
  for (const h of hits) {
    if (!byClass.has(h.cls)) byClass.set(h.cls, []);
    byClass.get(h.cls)!.push(h);
  }
  const sorted = [...byClass.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  );
  for (const [cls, occurrences] of sorted) {
    const entry = repByCls.get(cls);
    console.log(
      `${bold(yellow(cls))} ${dim(`(${occurrences.length})`)}${fmtRep(entry?.rep, entry?.approx)}`,
    );
    for (const h of occurrences) {
      console.log(`  ${cyan(h.file)}${dim(":")}${h.line}${dim(":")}${h.col}`);
    }
    console.log();
  }
} else {
  const byFile = new Map<string, Hit[]>();
  for (const h of hits) {
    if (!byFile.has(h.file)) byFile.set(h.file, []);
    byFile.get(h.file)!.push(h);
  }
  for (const [file, hs] of byFile) {
    console.log(bold(cyan(file)) + dim(` (${hs.length})`));
    for (const h of hs) {
      console.log(
        `  ${dim(`${h.line}:${h.col}`.padEnd(8))}${yellow(h.cls)}${arrow(h)}`,
      );
    }
    console.log();
  }
}

const uniqueClasses = new Set(hits.map((h) => h.cls)).size;
const uniqueFiles = new Set(hits.map((h) => h.file)).size;
console.log(
  bold(
    `${hits.length} occurrence${hits.length === 1 ? "" : "s"} · ` +
      `${uniqueClasses} unique class${uniqueClasses === 1 ? "" : "es"} · ` +
      `${uniqueFiles} file${uniqueFiles === 1 ? "" : "s"}`,
  ),
);
