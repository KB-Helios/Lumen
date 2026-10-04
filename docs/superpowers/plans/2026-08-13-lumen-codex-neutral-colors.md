# Lumen Codex-neutral Colors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Lumen's decorative rainbow palette with Codex-like graphite/off-white surfaces, one restrained teal-green accent, and neutral file glyphs.

**Architecture:** Keep the existing Tailwind CSS v4 semantic-token boundary. Change shared variables and the owned EinUI decoration in `global.css`, then simplify `FileGlyph` to consume one neutral role plus the existing selected accent; no component-local palettes or dependencies are added.

**Tech Stack:** React 19, TypeScript 6, Tailwind CSS v4, Vitest, Testing Library, Playwright, Bun.

## Global Constraints

- Use one muted teal-green accent for focus, selection, progress, and primary actions.
- Reserve green, amber, and red for genuine success, warning, and error states.
- Keep existing typography, spacing, geometry, motion, transparency controls, and Windows Acrylic/Mica/Blur behavior.
- Keep Windows forced-colors behavior unchanged.
- Use `bun` for all project commands and add no dependencies.
- Keep all visual changes behind the existing semantic contracts in `src/design-system`.

---

### Task 1: Neutral theme tokens and single-accent glass glow

**Files:**
- Modify: `src/design-system/global.test.ts`
- Modify: `src/design-system/global.css`

**Interfaces:**
- Consumes: existing `--lumen-*` semantic variables and `.einui-command-exterior-colour-glow` decoration.
- Produces: the same semantic variable names with neutral values; components require no API changes.

- [ ] **Step 1: Write failing CSS contract expectations**

Update the opaque-surface expectations and add a focused expectation for the new single-accent glow:

```ts
it('uses neutral opaque surfaces in light and dark themes', () => {
  expect(normalizedCss).toContain(`
[data-transparency='disabled'] {
  --lumen-canvas: #f5f4f0;
  --lumen-surface-glass: #fbfaf8;
  --lumen-surface-raised: #ffffff;
  --lumen-surface-inset: #e8e7e3;
}`);
  expect(normalizedCss).toContain(`
[data-resolved-theme='dark']:where([data-transparency='disabled']) {
  --lumen-canvas: #10100f;
  --lumen-surface-glass: #1b1b19;
  --lumen-surface-raised: #292927;
  --lumen-surface-inset: #0c0c0b;
}`);
});

it('uses one semantic accent for the command palette glow', () => {
  expect(normalizedCss).toContain(
    'background: radial-gradient(circle, color-mix(in srgb, var(--lumen-accent) 22%, transparent) 0%, transparent 72%);',
  );
  expect(normalizedCss).not.toContain('rgba(6, 182, 212, 0.2)');
  expect(normalizedCss).not.toContain('rgba(168, 85, 247, 0.2)');
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `rtk bun run test -- src/design-system/global.test.ts`

Expected: FAIL because the old blue opaque surfaces and cyan-blue-purple glow remain.

- [ ] **Step 3: Apply the minimal shared palette change**

Replace only the semantic color values in `:root`, `[data-resolved-theme="dark"]`, and the two opaque blocks:

```css
:root {
  --lumen-canvas: #f7f7f5;
  --lumen-surface-glass: rgba(255, 255, 252, 0.82);
  --lumen-surface-raised: rgba(255, 255, 255, 0.9);
  --lumen-surface-inset: rgba(226, 225, 222, 0.66);
  --lumen-text-primary: rgba(31, 30, 29, 0.94);
  --lumen-text-secondary: rgba(55, 53, 50, 0.7);
  --lumen-text-tertiary: rgba(81, 78, 74, 0.52);
  --lumen-accent: #0f7a67;
  --lumen-focus: #0b6f5c;
}

[data-resolved-theme="dark"] {
  --lumen-canvas: #111110;
  --lumen-surface-glass: rgba(28, 28, 27, 0.82);
  --lumen-surface-raised: rgba(43, 43, 41, 0.86);
  --lumen-surface-inset: rgba(8, 8, 8, 0.58);
  --lumen-text-primary: rgba(250, 250, 249, 0.96);
  --lumen-text-secondary: rgba(225, 224, 221, 0.74);
  --lumen-text-tertiary: rgba(196, 194, 190, 0.54);
  --lumen-accent: #63c7af;
  --lumen-focus: #76d2bb;
}

[data-transparency='disabled'] {
  --lumen-canvas: #f5f4f0;
  --lumen-surface-glass: #fbfaf8;
  --lumen-surface-raised: #ffffff;
  --lumen-surface-inset: #e8e7e3;
}

[data-resolved-theme='dark']:where([data-transparency='disabled']) {
  --lumen-canvas: #10100f;
  --lumen-surface-glass: #1b1b19;
  --lumen-surface-raised: #292927;
  --lumen-surface-inset: #0c0c0b;
}
```

Keep the existing semantic status values, borders, shadows, geometry, high-contrast mappings, and transparency behavior. Replace the colored exterior glow with:

```css
.einui-command-exterior-colour-glow {
  inset: -0.75rem;
  background: radial-gradient(circle, color-mix(in srgb, var(--lumen-accent) 22%, transparent) 0%, transparent 72%);
  filter: blur(40px);
  opacity: 0.58;
}
```

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run: `rtk bun run test -- src/design-system/global.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the shared palette**

```powershell
rtk git add src/design-system/global.css src/design-system/global.test.ts
rtk git commit -m "style: adopt codex-neutral palette"
```

---

### Task 2: Neutral file glyphs

**Files:**
- Modify: `src/design-system/file-glyphs/FileGlyph.test.tsx`
- Modify: `src/design-system/file-glyphs/FileGlyph.tsx`

**Interfaces:**
- Consumes: `FileGlyphProps` unchanged.
- Produces: every unselected file kind uses `text-text-secondary`; selected glyphs use `text-accent`; glyph geometry and accessibility behavior stay unchanged.

- [ ] **Step 1: Write the failing behavior expectations**

Extend the table test and selected-state test with rendered class assertions:

```ts
it.each(fileKinds)('renders a neutral %s glyph with an accessible title', (kind) => {
  const {container} = render(<FileGlyph kind={kind} title={`${kind} file`} />);
  const glyph = screen.getByTestId('file-glyph');

  expect(screen.getByTitle(`${kind} file`)).toBeInTheDocument();
  expect(container.querySelector('svg')).toHaveAttribute('stroke', 'currentColor');
  expect(glyph).toHaveClass('text-text-secondary');
  expect(glyph).not.toHaveClass('text-success', 'text-warning', 'text-danger');
});

it('uses the shared accent when selected without changing geometry', () => {
  const {rerender} = render(<FileGlyph kind="source" selected />);
  const selected = screen.getByTestId('file-glyph');
  const viewBox = selected.querySelector('svg')?.getAttribute('viewBox');

  expect(selected).toHaveAttribute('data-selected', 'true');
  expect(selected).toHaveClass('text-accent');
  rerender(<FileGlyph kind="source" selected={false} />);
  expect(screen.getByTestId('file-glyph')).toHaveClass('text-text-secondary');
  expect(screen.getByTestId('file-glyph').querySelector('svg')).toHaveAttribute('viewBox', viewBox);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `rtk bun run test -- src/design-system/file-glyphs/FileGlyph.test.tsx`

Expected: FAIL because file kinds still receive status/accent colors and selection uses primary text plus a colored drop shadow.

- [ ] **Step 3: Remove the file-kind palette**

Delete `kindClasses` and simplify the root class selection:

```tsx
className={cn(
  'inline-grid shrink-0 place-items-center',
  selected ? 'text-accent' : 'text-text-secondary',
)}
```

Do not change `glyphFor`, `FileGlyphProps`, SVG geometry, or title behavior.

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run: `rtk bun run test -- src/design-system/file-glyphs/FileGlyph.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the glyph simplification**

```powershell
rtk git add src/design-system/file-glyphs/FileGlyph.tsx src/design-system/file-glyphs/FileGlyph.test.tsx
rtk git commit -m "style: neutralize file glyph colors"
```

---

### Task 3: Full verification and visual evidence

**Files:**
- Regenerate: `artifacts/screenshots/*.png`
- Regenerate: `artifacts/screenshots/manifest.json`

**Interfaces:**
- Consumes: the completed semantic palette and neutral glyph treatment.
- Produces: checked-in gallery evidence for all 53 scenarios; no runtime API changes.

- [ ] **Step 1: Run static and unit verification**

Run each command and require exit code 0:

```powershell
rtk bun run typecheck
rtk bun run lint
rtk bun run test
```

- [ ] **Step 2: Ensure port 1420 is not serving stale code**

Run:

```powershell
rtk powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess"
```

If a listener exists, identify it before stopping only that verified Lumen/Vite process. Do not kill unrelated processes.

- [ ] **Step 3: Run E2E verification**

Run: `rtk bun run test:e2e`

Expected: all Playwright tests pass against the fresh auto-started dev server.

- [ ] **Step 4: Regenerate the visual gallery**

Run: `rtk bun run capture:gallery`

Expected: the manifest reports 53 captures and updates the gallery images for the current commit state.

- [ ] **Step 5: Inspect representative evidence**

Open and inspect these images at original resolution:

- `artifacts/screenshots/expanded-results.png`
- `artifacts/screenshots/theme-light.png`
- `artifacts/screenshots/theme-dark.png`
- `artifacts/screenshots/theme-opaque.png`
- `artifacts/screenshots/settings-general.png`
- `artifacts/screenshots/computer-use-approval.png`

Acceptance: surfaces read graphite/off-white; no cyan-blue-purple decoration or multicolor file-glyph row remains; accent is teal-green; success, warning, and danger states remain visibly distinct.

- [ ] **Step 6: Check the final diff**

Run:

```powershell
rtk git diff --check
rtk git status --short
```

Expected: no whitespace errors; only the plan, design-system implementation/tests, and regenerated screenshot evidence are changed.

- [ ] **Step 7: Commit the evidence**

```powershell
rtk git add artifacts/screenshots
rtk git commit -m "test: refresh codex-neutral ui evidence"
```
