// Pure routing — no theme data lives here. Values are loaded at runtime from
// the project's installed `tailwindcss/theme.css` plus any user @theme/:root
// declarations under the search root.

export type Table = Record<string, string>;

// Theme namespaces populated at runtime. Mirror the Tailwind v4 @theme keys.
export const NAMESPACES = {
  color: {} as Table,
  text: {} as Table,           // font-size
  "font-weight": {} as Table,
  leading: {} as Table,        // line-height (named entries only)
  tracking: {} as Table,       // letter-spacing
  radius: {} as Table,
  shadow: {} as Table,
  "inset-shadow": {} as Table,
  "drop-shadow": {} as Table,
  blur: {} as Table,
  font: {} as Table,           // font-family
  ease: {} as Table,
  animate: {} as Table,
  breakpoint: {} as Table,
  container: {} as Table,
  perspective: {} as Table,
  aspect: {} as Table,
} as const;

export type NamespaceKey = keyof typeof NAMESPACES;

// Spacing base read from `--spacing` (v4 single multiplier). Set at runtime.
export const spacingBase = { px: null as number | null };

// CSS namespace alias -> internal namespace key. Older or alternate names
// supported for user CSS authors.
export const NAMESPACE_ALIASES: Record<string, NamespaceKey> = {
  color: "color",
  text: "text",
  "font-size": "text",
  "font-weight": "font-weight",
  leading: "leading",
  "line-height": "leading",
  tracking: "tracking",
  "letter-spacing": "tracking",
  radius: "radius",
  "border-radius": "radius",
  shadow: "shadow",
  "box-shadow": "shadow",
  "inset-shadow": "inset-shadow",
  "drop-shadow": "drop-shadow",
  blur: "blur",
  font: "font",
  "font-family": "font",
  ease: "ease",
  animate: "animate",
  breakpoint: "breakpoint",
  container: "container",
  perspective: "perspective",
  aspect: "aspect",
};

// Rule kinds for resolving an arbitrary value:
// - theme: look in a populated namespace table.
// - spacing: value matches N × --spacing (any 0.25-step multiple) → "N".
// - integer-px: value is "<int>px" → "<int>" (v4 dynamic width utilities).
// - integer: value is bare "<int>" → "<int>" (z, order, etc.).
// - ms: value is "<int>ms" → "<int>" (duration, delay).
// - percent: value is "<int>%" → "<int>" or bare integer (opacity).
export type Rule =
  | { kind: "theme"; ns: NamespaceKey }
  | { kind: "spacing" }
  | { kind: "integer-px" }
  | { kind: "integer" }
  | { kind: "ms" }
  | { kind: "percent" };

export const PREFIX_RULES: Record<string, Rule[]> = {};
const add = (prefixes: string[], rules: Rule[]): void => {
  for (const p of prefixes) PREFIX_RULES[p] = rules;
};

// Spacing-driven utilities (v4 derives from `--spacing`).
add(
  [
    "p", "px", "py", "pt", "pb", "pl", "pr", "ps", "pe",
    "m", "mx", "my", "mt", "mb", "ml", "mr", "ms", "me",
    "space-x", "space-y",
    "gap", "gap-x", "gap-y",
    "w", "h", "size", "min-w", "max-w", "min-h", "max-h", "basis",
    "top", "right", "bottom", "left", "start", "end",
    "inset", "inset-x", "inset-y",
    "translate-x", "translate-y", "translate",
    "scroll-m", "scroll-mx", "scroll-my", "scroll-mt", "scroll-mb", "scroll-ml", "scroll-mr",
    "scroll-p", "scroll-px", "scroll-py", "scroll-pt", "scroll-pb", "scroll-pl", "scroll-pr",
    "indent",
  ],
  [{ kind: "spacing" }],
);

// Typography
add(["text"], [{ kind: "theme", ns: "text" }, { kind: "theme", ns: "color" }]);
add(["font"], [{ kind: "theme", ns: "font-weight" }, { kind: "theme", ns: "font" }]);
add(["leading"], [{ kind: "theme", ns: "leading" }, { kind: "spacing" }]);
add(["tracking"], [{ kind: "theme", ns: "tracking" }]);

// Radius
add(
  [
    "rounded", "rounded-t", "rounded-r", "rounded-b", "rounded-l",
    "rounded-tl", "rounded-tr", "rounded-bl", "rounded-br",
    "rounded-s", "rounded-e", "rounded-ss", "rounded-se", "rounded-es", "rounded-ee",
  ],
  [{ kind: "theme", ns: "radius" }],
);

// Borders / rings / outlines — v4 width utilities are dynamic integer px.
add(
  ["border", "border-x", "border-y", "border-t", "border-r", "border-b", "border-l", "border-s", "border-e"],
  [{ kind: "integer-px" }, { kind: "theme", ns: "color" }],
);
add(["divide", "divide-x", "divide-y"], [{ kind: "integer-px" }, { kind: "theme", ns: "color" }]);
add(["ring"], [{ kind: "integer-px" }, { kind: "theme", ns: "color" }]);
add(["ring-offset"], [{ kind: "integer-px" }, { kind: "theme", ns: "color" }]);
add(["outline"], [{ kind: "integer-px" }, { kind: "theme", ns: "color" }]);
add(["outline-offset"], [{ kind: "integer-px" }]);

// Colors-only
add(
  ["bg", "fill", "stroke", "from", "via", "to", "accent", "caret", "placeholder", "decoration"],
  [{ kind: "theme", ns: "color" }],
);

// Effects
add(["shadow"], [{ kind: "theme", ns: "shadow" }, { kind: "theme", ns: "color" }]);
add(["inset-shadow"], [{ kind: "theme", ns: "inset-shadow" }, { kind: "theme", ns: "color" }]);
add(["drop-shadow"], [{ kind: "theme", ns: "drop-shadow" }]);
add(["blur", "backdrop-blur"], [{ kind: "theme", ns: "blur" }]);

// Numeric scales (v4 dynamic)
add(["opacity", "bg-opacity", "text-opacity", "border-opacity", "ring-opacity", "divide-opacity", "placeholder-opacity"], [{ kind: "percent" }]);
add(["z"], [{ kind: "integer" }]);
add(["order"], [{ kind: "integer" }]);
add(["duration", "transition-duration"], [{ kind: "ms" }]);
add(["delay", "transition-delay"], [{ kind: "ms" }]);

// Motion / layout
add(["ease"], [{ kind: "theme", ns: "ease" }]);
add(["animate"], [{ kind: "theme", ns: "animate" }]);
add(["aspect"], [{ kind: "theme", ns: "aspect" }]);
add(["perspective"], [{ kind: "theme", ns: "perspective" }]);
