import {fireEvent, render, screen} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import type {LumenButton as ButtonComponent} from '../../design-system/primitives/LumenButton';
import type {SearchResult} from '../../services/search/search.types';
import {ContextActions} from './ContextActions';

const {buttonRender} = vi.hoisted(() => ({buttonRender: vi.fn()}));
vi.mock('../../design-system/primitives/LumenButton', async (original) => {
  const {LumenButton} = await original<{LumenButton: typeof ButtonComponent}>();
  return {LumenButton: (props: React.ComponentProps<typeof LumenButton>) => {
    buttonRender();
    return <LumenButton {...props} />;
  }};
});

describe('ContextActions', () => {
  it('updates selected text without rerendering unchanged buttons, then updates eligibility immediately', () => {
    const handlers = {onDetails: vi.fn(), onOpen: vi.fn(), onOpenContainingFolder: vi.fn(), onPin: vi.fn()};
    const first: SearchResult = {id: 'first', name: 'First', path: 'C:\\fixture\\first', kind: 'document', availability: 'available', match: {source: 'filename', fragment: ''}, metadata: {}};
    const {rerender} = render(<ContextActions {...handlers} result={first} />);
    const rendered = buttonRender.mock.calls.length;
    rerender(<ContextActions {...handlers} result={{...first, id: 'second', name: 'Second', path: 'C:\\fixture\\second'}} />);
    expect(screen.getByTitle('C:\\fixture\\second')).toHaveTextContent('Second');
    expect(buttonRender).toHaveBeenCalledTimes(rendered);
    rerender(<ContextActions {...handlers} result={{...first, kind: 'app-content', pinned: true, provenance: {fileHash: 'fixture', indexRevision: 1, extractionKind: 'text'}}} />);
    expect(screen.getByRole('button', {name: 'Open containing folder'})).toBeDisabled();
    expect(screen.getByRole('button', {name: 'Unpin selected result'})).toBeEnabled();
    rerender(<ContextActions {...handlers} result={null} />);
    expect(screen.getByRole('button', {name: 'Open selected result'})).toBeDisabled();
    expect(screen.getByRole('button', {name: 'Show file details'})).toBeDisabled();
  });

  it('uses the latest target callbacks and applies opening state synchronously', () => {
    const actions = {onDetails: vi.fn(), onOpen: vi.fn(), onOpenContainingFolder: vi.fn(), onPin: vi.fn()};
    const first: SearchResult = {id: 'first', name: 'First', path: 'first', kind: 'document', availability: 'available', match: {source: 'filename', fragment: ''}, metadata: {}, provenance: {fileHash: 'fixture', indexRevision: 1, extractionKind: 'text'}};
    const {rerender} = render(<ContextActions {...actions} result={first} />);
    const rendered = buttonRender.mock.calls.length;
    const latest = {...first, id: 'second', name: 'Second'};
    const next = {onDetails: vi.fn(), onOpen: vi.fn(), onOpenContainingFolder: vi.fn(), onPin: vi.fn()};
    rerender(<ContextActions {...next} result={latest} />);
    expect(buttonRender).toHaveBeenCalledTimes(rendered);
    for (const label of ['Open selected result', 'Open containing folder', 'Pin selected result', 'Show file details']) fireEvent.click(screen.getByRole('button', {name: label}));
    for (const handler of Object.values(actions)) expect(handler).not.toHaveBeenCalled();
    for (const handler of Object.values(next)) expect(handler).toHaveBeenCalledOnce();
    rerender(<ContextActions {...next} result={latest} isOpening />);
    expect(screen.getByRole('button', {name: 'Opening selected result'})).toBeDisabled();
    fireEvent.click(screen.getByRole('button', {name: 'Opening selected result'}));
    expect(next.onOpen).toHaveBeenCalledOnce();
  });
});
