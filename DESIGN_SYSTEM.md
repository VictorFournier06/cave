# Cave — Design System

A small, purpose-built design system for the Cave app. It lives in one file,
[`public/styles.css`](public/styles.css), and is consumed by
[`public/index.html`](public/index.html). This document explains how it's put
together and how to extend it.

The visual world is a **wine cellar**: warm sand paper, ivory glass, bordeaux
wine. Type is an elegant serif for names + a system sans for the UI. It is
mobile-first, touch-friendly, and works in light and dark.

---

## The three layers

The system is layered so a single change at the bottom ripples up without
touching components. CSS `@layer`s enforce the order:

```
@layer primitives, semantic, base, components, utilities;
```

### 1. Primitives — raw values (`@layer primitives`)

Mode-stable raw values. Never used directly by components; they feed the
semantic layer. Colour **ramps** (50 → 900), type scale, spacing, radius,
shadow, motion.

```
--wine-600:#7A2E39;      /* accent ramp: 50 (palest) … 900 (deepest) */
--sand-50 … --sand-900;  /* warm neutral: paper → ink */
--green/-amber/-slate;   /* status ramps */
--hue-rouge, --hue-champagne, …  /* one data colour per wine type */
--text-lg:1.125rem; --space-4:1rem; --radius-md:12px; --shadow-md:…;
```

### 2. Semantic — theme-aware roles (`@layer semantic`)

What the UI actually references. Each role maps to a primitive and **flips with
the theme**. This is the only layer you theme; components never contain a raw
hex.

| Role | Token | Light | Dark |
|---|---|---|---|
| Page | `--bg` | sand-50 | `#1A1511` |
| Card / control | `--surface-1` | white | `#241E18` |
| Sunken | `--surface-2` | sand-100 | `#2D251D` |
| Body text | `--text` | sand-900 | sand-100 |
| Muted text | `--text-muted` | sand-600 | sand-400 |
| Hairline | `--border` | sand-200 | `#3A2F24` |
| Accent | `--accent` | wine-600 | `#CC8797` |
| On accent | `--accent-contrast` | sand-50 | `#1A1511` |
| Accent wash | `--accent-soft` | wine-100 | rgba wine |

**Status** roles are separate from the accent (they encode meaning, not brand):
`--st-ready-*` (green, à boire), `--st-late-*` (amber, en retard),
`--st-keep-*` (slate, à garder), `--st-unknown-*` (grey). Each has an `-fg`
(text/icon) and a `-bg` (soft fill).

Theme is set three ways, and all resolve to the same tokens:
`@media (prefers-color-scheme)` for the OS default, then
`:root[data-theme="light"|"dark"]` when the in-app toggle overrides it.

### 3. Components — reusable classes (`@layer components`)

Built entirely from semantic tokens. See the table below.

`@layer base` sits between semantic and components: element resets, typography
defaults, focus rings, and the custom scrollbars. `@layer utilities` holds
layout helpers (`.stack`, `.cluster`, `.between`, `.row2/.row3`, `.grow`).

---

## Scales

- **Type** — serif (`--font-serif`, Iowan/Palatino/Georgia) for names and
  headings; sans (`--font-sans`, system-ui) for UI. Sizes `--text-xs`(.75rem) →
  `--text-3xl`(2.25rem). Numbers that align use `.num` (tabular figures).
- **Space** — 4px base: `--space-1`(4) … `--space-12`(48). Lay out with `gap`,
  not per-element margins.
- **Radius** — `--radius-sm`(8) `md`(12) `lg`(16) `xl`(22) `pill`(999).
- **Elevation** — warm-tinted `--shadow-sm/md/lg`.
- **Touch** — `--tap` (44px) minimum target on every interactive control.

---

## Components

| Class | What it is |
|---|---|
| `.btn` (+ `--primary` `--ghost` `--danger` `--block` `--sm`) | Buttons. One primary per view. |
| `.iconbtn` | 44px round icon button; `data-count` shows a badge (used by the filter button). |
| `.chip[aria-pressed]` | Toggle chip for filters; optional colour `.dot`. |
| `.pill` (`--ready` `--late` `--keep` `--unknown`, `--est`) | Status pill. `--est` = dashed = an estimated maturité window. |
| `.card` / `.row` | Surface container / 3-column list row (dot · content · meta). |
| `.field`, `.input` | Labelled form control. Grids `.row2` / `.row3` use `minmax(0,1fr)` so inputs shrink (no overflow). |
| `.toggle` | iOS-style switch. |
| `.fab` | Floating action button (safe-area aware). |
| `.backdrop` + `.sheet` | Bottom-sheet modal (centred dialog ≥620px). `.sheet__head` / `.grip`. |
| `.toast` | Transient confirmation. |
| `.steps` | Numbered instructions (install guide). |
| `.label` `.muted` `.subtle` `.num` `.serif` | Text roles. |

Icons are inline **Material Symbols** SVG paths (in `index.html`'s `ICONS` map),
sized via the `svg(name,size)` helper and coloured with `currentColor` — no
icon font, so they work offline.

---

## App composition

Generic components live in `styles.css`. Classes specific to *this* app's
layout live in a small `<style>` block in `index.html`: `.appbar`, `.summary` +
`.drink-now`, `.controls` + `.listbar` + `.sortbtn`, `.active-filters` +
`.fchip`, `.wine-nom/.wine-sub/.qte`, and the sheet-body bits. Keeping them
separate keeps the design system reusable.

### Layout decisions (the UX rules this redesign enforces)

- **List-first.** The header is a compact "à boire maintenant" banner + one
  summary line — not a wall of stat cards. The list owns the screen.
- **Filters live in a sheet**, opened from the `tune` icon in the app bar, and
  they **wrap** — never a horizontal scroll. Active filters show as removable
  `.fchip`s under the toolbar so they're visible without reopening the sheet.
- **Sort is its own control** (`.sortbtn` → sort sheet), never mixed into the
  filter row.

---

## Extending it

1. New colour? Add a ramp in `@layer primitives`, map it to a semantic role in
   `@layer semantic` (both light and dark), then reference the **role**.
2. New component? Build it in `@layer components` from semantic tokens only —
   never a raw hex, so it themes for free.
3. Mental test for any change: *if the background were near-black, would every
   text and border still read?* If not, you used a primitive where a semantic
   token belongs.
