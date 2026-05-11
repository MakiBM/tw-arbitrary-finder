# tw-arbitrary-finder

Find Tailwind arbitrary-value classes — the `text-[13px]`, `bg-[#abc123]`, `top-[calc(100%-1rem)]` magic-number escape hatches — across your codebase. Useful for auditing before consolidating one-off values back into your theme.

## Usage

```bash
# Default: scan common web file types in cwd
npx tw-arbitrary-finder

# Explicit globs
npx tw-arbitrary-finder "src/**/*.{ts,tsx,jsx,vue,svelte,html}"

# Group by class instead of by file
npx tw-arbitrary-finder --group

# Just print counts, sorted desc — great for "which magic class is worst?"
npx tw-arbitrary-finder --counts-only

# Machine-readable
npx tw-arbitrary-finder --json > report.json

# Custom ignores (repeatable)
npx tw-arbitrary-finder --ignore "**/*.test.tsx" --ignore "legacy/**"
```

## What it matches

- `text-[13px]`, `bg-[#1da1f2]`, `w-[42rem]`
- Variants: `md:hover:translate-x-[-2px]`
- Important: `!pb-[270px]`
- Negative: `-mt-[3px]`
- CSS function calls: `top-[calc(100%-1rem)]`, `bg-[url(...)]`
- Arbitrary properties: `[mask-type:luminance]` (matched as a permissive case)

## What it ignores

By default: `node_modules`, `.git`, `dist`, `build`, `.next`, `out`, `coverage`, `.turbo`, `.cache`.

## Caveats

It's a regex-based scanner, not a parser. It looks at text only — so it will find arbitrary classes in comments and strings too. That's almost always what you want for an audit. False positives are rare in practice but possible (e.g. in unrelated code that happens to contain `something-[foo]` syntax).

## License

MIT
