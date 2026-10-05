import {render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe, expect, it, vi} from 'vitest';

import {LumenMark} from '../icons/LumenMark';
import {LumenButton} from './LumenButton';
import {LumenIconButton} from './LumenIconButton';
import {LumenSurface} from './LumenSurface';
import {LumenText} from './LumenText';

describe('Lumen primitives', () => {
  it('exposes accessible keyboard-operable buttons', async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();

    render(
      <>
        <LumenButton onPress={onPress} variant="primary">Continue</LumenButton>
        <LumenIconButton aria-label="Open settings">
          <LumenMark />
        </LumenIconButton>
      </>,
    );

    const action = screen.getByRole('button', {name: 'Continue'});
    expect(action).toHaveAttribute('data-variant', 'primary');
    expect(screen.getByRole('button', {name: 'Open settings'})).toBeVisible();

    await user.tab();
    expect(action).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onPress).toHaveBeenCalledOnce();
  });

  it('keeps material decoration out of the accessibility tree', () => {
    render(
      <LumenSurface data-testid="surface" material="mica" aria-label="Search surface">
        <LumenText as="h1" variant="display">
          Find anything
        </LumenText>
      </LumenSurface>,
    );

    const surface = screen.getByLabelText('Search surface');
    expect(screen.getByTestId('surface')).toHaveAttribute('data-material', 'mica');
    expect(surface).toHaveAttribute('data-material', 'mica');
    expect(screen.getByRole('heading', {name: 'Find anything'})).toBeVisible();
    expect(surface.querySelectorAll('[aria-hidden="true"]')).toHaveLength(3);
  });

  it('keeps authored layout children directly owned by the surface', () => {
    render(
      <LumenSurface aria-label="Shell">
        <header>Header</header>
        <main>Main</main>
      </LumenSurface>,
    );

    const surface = screen.getByLabelText('Shell');
    expect(screen.getByRole('banner').parentElement).toBe(surface);
    expect(screen.getByRole('main').parentElement).toBe(surface);
  });

  it('uses semantic inner edges and suppresses shadows under app-controlled high contrast', () => {
    render(
      <>
        <LumenSurface data-testid="mica-surface" material="mica">
          Mica
        </LumenSurface>
        <LumenSurface data-testid="inset-surface" material="inset">
          Inset
        </LumenSurface>
      </>,
    );

    const micaSurface = screen.getByTestId('mica-surface');
    const insetSurface = screen.getByTestId('inset-surface');

    expect(micaSurface).toHaveClass('high-contrast:shadow-none');
    expect(micaSurface.querySelector('[aria-hidden="true"]')?.className).toContain('var(--lumen-border-specular)');
    expect(insetSurface).toHaveClass('high-contrast:shadow-none');
    expect(insetSurface).toHaveClass('shadow-none');
  });

  it('uses the shared 24-unit icon geometry', () => {
    const {container} = render(<LumenMark title="Lumen" />);
    const icon = container.querySelector('svg');

    expect(icon).toHaveAttribute('viewBox', '0 0 24 24');
    expect(icon).toHaveAttribute('aria-label', 'Lumen');
    expect(icon?.querySelector('[vector-effect="non-scaling-stroke"]')).not.toBeNull();
  });
});
