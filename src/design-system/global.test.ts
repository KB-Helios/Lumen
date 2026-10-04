import {describe, expect, it} from 'vitest';

import css from './global.css?raw';

const normalizedCss = css.replace(/\r\n/g, '\n');

describe('Lumen CSS appearance contract', () => {
  it('maps the translucent light command palette to readable semantic colors', () => {
    expect(normalizedCss).toContain(`
[data-resolved-theme='light'] .einui-command-palette-wrapper {
  --einui-command-surface: var(--lumen-surface-raised);
  --einui-command-text: var(--lumen-text-primary);
  --einui-command-muted-text: var(--lumen-text-secondary);
  --einui-command-border: var(--lumen-border-strong);
  --einui-command-divider: var(--lumen-border-subtle);
  --einui-command-row: var(--lumen-surface-inset);
  --einui-command-row-hover: var(--lumen-surface-inset);
  --einui-command-row-selected: var(--lumen-surface-inset);
  --einui-command-shortcut: var(--lumen-surface-raised);
  --einui-command-shadow: var(--lumen-shadow-control);
}`);
  });

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
    const glowRuleMatch = normalizedCss.match(
      /\.einui-command-exterior-colour-glow\s*\{[^}]*\}/s,
    );
    expect(glowRuleMatch).toBeTruthy();

    const glowRule = glowRuleMatch![0];
    expect(glowRule).toContain('var(--lumen-accent)');
    expect(glowRule).toContain(
      'background: radial-gradient(circle, color-mix(in srgb, var(--lumen-accent) 22%, transparent) 0%, transparent 72%);',
    );
    expect(glowRule).not.toMatch(/rgba\(\d+,\s*\d+,\s*\d+/);
    expect(glowRule).not.toMatch(/rgb\(\d+,\s*\d+,\s*\d+/);
    expect(glowRule).not.toMatch(/#[0-9a-fA-F]{3,8}(?![^}]*var\()/);
  });

  it('maps every shared semantic Tailwind color role to system colors in high contrast', () => {
    expect(normalizedCss).toContain(`
[data-contrast='high'] {
  --lumen-canvas: Canvas;
  --lumen-surface-glass: Canvas;
  --lumen-surface-raised: ButtonFace;
  --lumen-surface-inset: ButtonFace;
  --lumen-text-primary: CanvasText;
  --lumen-text-secondary: CanvasText;
  --lumen-text-tertiary: CanvasText;
  --lumen-text-inverse: HighlightText;
  --lumen-text-button: ButtonText;
  --lumen-accent: Highlight;
  --lumen-focus: Highlight;
  --lumen-border-subtle: CanvasText;
  --lumen-border-strong: CanvasText;
  --lumen-border-specular: CanvasText;
  --lumen-success: CanvasText;
  --lumen-warning: CanvasText;
  --lumen-danger: CanvasText;
  --lumen-scrim: Canvas;
  --lumen-shadow-surface: none;
  --lumen-shadow-control: none;
}`);
  });
});
