import {render, screen} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';

import type {AppearancePreferences} from '../design-system/theme';
import {appearanceStore} from '../state/appearance.store';
import {AppProviders} from './AppProviders';
import {useSettingsStore} from '../features/settings/settings.store';

const fullMotion: AppearancePreferences = {
  effects: 'full',
  mode: 'system',
  motion: 'full',
  transparency: 'native',
};

function mockMediaPreferences(matches: Partial<Record<string, boolean>>) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    addEventListener: () => undefined,
    matches: matches[query] ?? false,
    media: query,
    removeEventListener: () => undefined,
  }));
}

function renderAppearance(
  appearance: AppearancePreferences,
  forceHighContrast = false,
) {
  render(
    <AppProviders appearance={appearance} forceHighContrast={forceHighContrast}>
      <span>Child</span>
    </AppProviders>,
  );

  return screen.getByRole('application', {name: 'Lumen'});
}

function expectApplicationRoot(root: HTMLElement) {
  expect(root).toHaveClass('h-full', 'w-full', 'bg-transparent', 'font-sans', 'text-text-primary');
}

describe('AppProviders appearance contract', () => {
  it('shares decorative glass intensity with a neutral 72 baseline', () => {
    useSettingsStore.setState({presentation: {glassIntensity: 36}});
    const root = renderAppearance(fullMotion);
    expect(root.style.getPropertyValue('--lumen-glass-strength')).toBe('0.5');
    expect(root.style.opacity).toBe('');
  });
  afterEach(() => {
    useSettingsStore.setState({presentation: {glassIntensity: 72}});
    appearanceStore.setState({density: 'comfortable'});
    vi.unstubAllGlobals();
  });

  it('exposes the persisted launcher density', () => {
    appearanceStore.setState({density: 'compact'});

    const root = renderAppearance(fullMotion);

    expect(root).toHaveAttribute('data-density', 'compact');
  });

  it('resolves the system appearance as light', () => {
    mockMediaPreferences({'(prefers-color-scheme: dark)': false});

    const root = renderAppearance(fullMotion);

    expect(root).toHaveAttribute('data-resolved-theme', 'light');
    expectApplicationRoot(root);
  });

  it('exposes opaque appearance through data attributes', () => {
    const root = renderAppearance({...fullMotion, mode: 'dark', transparency: 'disabled'});

    expect(root).toHaveAttribute('data-resolved-theme', 'dark');
    expect(root).toHaveAttribute('data-transparency', 'disabled');
    expectApplicationRoot(root);
  });

  it('exposes forced high contrast through data attributes', () => {
    mockMediaPreferences({'(forced-colors: active)': true});

    const root = renderAppearance({...fullMotion, mode: 'dark'});

    expect(root).toHaveAttribute('data-contrast', 'high');
    expectApplicationRoot(root);
  });

  it('exposes reduced effects and motion through data attributes', () => {
    const root = renderAppearance({
      effects: 'reduced',
      mode: 'dark',
      motion: 'reduced',
      transparency: 'native',
    });

    expect(root).toHaveAttribute('data-effects', 'reduced');
    expect(root).toHaveAttribute('data-reduced-motion', 'true');
    expectApplicationRoot(root);
  });
});
