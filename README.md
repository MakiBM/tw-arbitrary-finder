# tw-arbitrary-finder

Find Tailwind arbitrary-value classes — the `text-[13px]`, `bg-[#ef4444]`, `top-[calc(100%-1rem)]` magic-number escape hatches — across your codebase, and **see which ones can be swapped for a default Tailwind token**.

By default the tool only shows arbitrary classes whose value matches a Tailwind default (so the suggestion is exact and safe), e.g.:

```
text-[14px]       ->  text-sm
bg-[#ef4444]      ->  bg-red-500
p-[16px]          ->  p-4
rounded-[2px]     ->  rounded-sm
min-w-[8rem]      ->  min-w-32
ring-[3px]        ->  ring
```

Pass `--all` to see every arbitrary class, replaceable or not.

## Usage

```bash
# Scan a directory (recursively, default extensions)
npx tw-arbitrary-finder ./src

# Or with explicit globs
npx tw-arbitrary-finder "src/**/*.{ts,tsx,jsx,vue,svelte,html}"

# Default in cwd
npx tw-arbitrary-finder

# Show every arbitrary class, not only the replaceable ones
npx tw-arbitrary-finder --all

# Group by class instead of by file
npx tw-arbitrary-finder --group

# Just print counts, sorted desc
npx tw-arbitrary-finder --counts-only

# Machine-readable (includes the suggested replacement per hit)
npx tw-arbitrary-finder --json > report.json

# Custom ignores (repeatable, on top of the defaults)
npx tw-arbitrary-finder --ignore "**/*.test.tsx" --ignore "legacy/**"

# Disable .gitignore handling (it's honored by default)
npx tw-arbitrary-finder --no-gitignore
```

## What it matches

- `text-[13px]`, `bg-[#1da1f2]`, `w-[42rem]`
- Variants: `md:hover:translate-x-[-2px]`
- Important: `!pb-[270px]`
- Negative: `-mt-[3px]`
- CSS function calls: `top-[calc(100%-1rem)]`, `bg-[url(...)]`

## Replacement matching

Values are normalized before lookup, so equivalent units match:

- `rem` and `em` are treated as `px` (16px root) — `1rem` == `16px`
- `s` is treated as `ms` — `0.3s` == `300ms`
- `#fff` and `#FFFFFF` normalize to `#ffffff`
- `white`, `black`, `transparent`, `currentColor`, `inherit` map to their named tokens

The tool knows the full Tailwind v3 default theme: spacing scale, font sizes, font weights, line-heights, letter-spacing, rounded, border/ring/outline widths, opacity, z-index, order, duration/delay, and the complete default color palette (slate, gray, …, rose).

## What it ignores

- Defaults: `node_modules`, `.git`, `dist`, `build`, `.next`, `out`, `coverage`, `.turbo`, `.cache`.
- `.gitignore` files (walking up to the nearest `.git` repo root). Disable with `--no-gitignore`.
- Extra `--ignore <glob>` patterns.

## Caveats

It's a regex-based scanner, not a parser. It looks at text only — so it will find arbitrary classes in comments and strings too. That's almost always what you want for an audit. False positives are rare in practice but possible.

## License

MIT
