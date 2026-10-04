# Lumen Codex-neutral colors design

**Date:** 2026-08-13  
**Status:** Approved

## Goal

Make Lumen feel closer to ChatGPT Codex: quiet graphite and off-white surfaces, one restrained teal-green accent, and semantic colors only when they communicate status. Preserve Lumen's Windows material character without the current rainbow effect.

## Visual direction

- Use neutral graphite surfaces in dark mode and warm off-white surfaces in light mode.
- Use one muted teal-green accent for focus, selection, progress, and primary actions.
- Replace the cyan-to-blue-to-purple command-palette glow with one faint accent glow and neutral white specular light.
- Render file-type glyphs in the shared secondary text color. A selected glyph may use the accent, but not a colored drop shadow.
- Reserve green, amber, and red for genuine success, warning, and error states.
- Keep the existing typography, spacing, geometry, motion, transparency controls, and Windows Acrylic/Mica/Blur behavior.

## Token changes

The implementation stays inside the existing semantic contract in `src/design-system/global.css`:

- Light surfaces move from cool blue-gray toward warm neutral gray.
- Dark surfaces move from blue-black toward near-black graphite.
- `--lumen-accent` and `--lumen-focus` become muted teal-green values with sufficient contrast in their respective themes.
- Opaque surface tokens use the same neutral hue family.
- Borders, shadows, and specular layers remain neutral.
- Success, warning, danger, and Windows forced-color mappings remain semantically distinct.

Components continue consuming semantic Tailwind utilities. No page-local palette or new styling abstraction is introduced.

## Component treatment

`FileGlyph` stops assigning a different semantic color to each file kind. All kinds share a neutral foreground; selection uses the existing accent role. File shapes still distinguish kinds without relying on color.

The owned EinUI command palette keeps its glass recipe, but its exterior decoration uses only the Lumen accent at low opacity. The neutral specular layers remain to convey glass depth.

No layout, behavior, provider routing, native command, or persistence code changes.

## Accessibility

- Windows forced-colors behavior remains unchanged.
- Focus stays visibly distinct in light, dark, opaque, and high-contrast modes.
- Error, warning, and success meanings remain paired with text or iconography rather than color alone.
- File types remain identifiable by glyph shape and label after kind-specific colors are removed.

## Verification

Add focused regression expectations before implementation for the neutral file-glyph contract and the single-accent palette decoration. Then run:

1. Focused design-system tests.
2. `bun run typecheck`.
3. `bun run lint`.
4. `bun run test`.
5. `bun run test:e2e` against a fresh dev server.
6. `bun run capture:gallery` and inspect representative dark, light, opaque, launcher, settings, and status screenshots.

The change is complete when the shared UI reads as neutral graphite/off-white, decorative rainbow hues are absent, the teal-green accent is restrained, semantic states remain clear, and all verification passes.
