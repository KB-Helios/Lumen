# Lumen design system

Lumen owns its authored visual language through Tailwind CSS v4's CSS-first semantic variables. Components consume semantic utilities backed by the global token contract; product code does not introduce page-local palettes or arbitrary motion timings.

## Ownership

- Tailwind CSS v4 owns authored layout, appearance, themes, and semantic tokens through `src/design-system/global.css`.
- React Aria Components owns behavior and accessibility for Lumen-authored controls.
- Motion for React owns meaningful spatial transitions and follows the resolved motion preference.
- `LumenUiIcon` is the typed bridge to OpenAI Apps SDK UI interface icons. Product-specific symbols use `LumenIcon`'s 24-unit, current-color SVG frame.
- The owned EinUI command palette is vendored source, not a runtime dependency. Its provenance ledger records the upstream revision, license, retained layer topology, and deliberate semantic-theme adaptations.

StyleX, Astryx, and Phosphor have no remaining Lumen runtime or authored-style path. Apps SDK UI supplies interface chrome only; it does not determine provider identity, routing, credentials, or product styling.

## Theme axes

The application resolves color mode, transparency, effects, contrast, and motion independently. System color and motion preferences remain live through `matchMedia`. Forced colors replaces authored color roles with system colors. Disabled transparency removes blur, luminosity, and noise; reduced effects lowers blur and shadow intensity. All variants preserve the same geometry and information hierarchy.

Appearance data is validated with Zod before entering the Zustand store or being written. Native Store failures leave the user's optimistic edit visible and expose a structured recoverable error.

## Material and primitives

`LumenSurface` is the material boundary. It composes a semantic tint, a subtle inner edge, low-opacity procedural noise, and one elevation shadow while keeping its three decorative nodes out of the accessibility tree. `mica`, `raised`, `inset`, and `flat` describe hierarchy rather than individual screens. Insets and flat surfaces use borders without additional elevation.

The launcher consumes the same graphite/off-white surface, text, and border roles as management surfaces. Neutral 3%, 6%, and 10% foreground mixes distinguish quiet, hovered, and selected controls. Blue remains the focus and intentional-emphasis accent (`#0066cc` light, `#5aa2ff` dark), with theme-adjusted focus shades (`#005fcc` light, `#80baff` dark). Primary actions use the semantic inverse foreground for readable contrast. Semantic status colors remain independent. High-contrast selected and hovered result labels and glyphs resolve to `HighlightText` over `Highlight`.

`LumenButton`, `LumenIconButton`, and `LumenText` carry shared focus, keyboard, type, and density rules. Icon-only buttons require an accessible name. Focus remains a visible semantic outline in every theme, including Windows forced-colors mode.

Control targets use stable 32/36/44px minimum heights and pixel gutters so enlarged text expands content without inflating all chrome. Form-control font and color resets live in Tailwind's base layer, allowing semantic text and typography utilities to override them. CSS timing variables in `global.css` mirror the TypeScript motion tokens. Content typography continues to use rem units.

## Responsive content

Inline preview observes the actual result/preview content box. Automatic preview requires the normal 800px launcher width, always requires 760px, and both require 220px of usable content height; measurement allows for the launcher's two border pixels. The preference yields before either primary content region becomes unusable.

Result metadata uses a named result-column container: source labels appear at 560px and the selected-row Enter hint at 680px. Filename matches show their filename and path once. Answer text has a bounded scroll viewport derived from the inner workspace's available height. Enlarged text can scroll the combined inner workspace while result actions and status stay anchored.

