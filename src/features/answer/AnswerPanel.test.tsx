import {render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe, expect, it, vi} from 'vitest';

import {AppProviders} from '../../app/AppProviders';
import {AnswerPanel} from './AnswerPanel';

describe('AnswerPanel', () => {
  it('does not offer answer actions before a submission exists', () => {
    render(
      <AppProviders>
        <AnswerPanel
          answer={{phase: 'idle', text: '', citations: []}}
          mode="auto"
          onModeChange={vi.fn()}
          onOpenCitation={vi.fn()}
          onRetry={vi.fn()}
          onStop={vi.fn()}
        />
      </AppProviders>,
    );

    expect(screen.queryByRole('button', {name: 'Retry answer'})).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {name: 'Copy answer'})).not.toBeInTheDocument();
  });

  it('exposes the actual route and lets the user switch execution mode', async () => {
    const user = userEvent.setup();
    const onModeChange = vi.fn();

    render(
      <AppProviders>
        <AnswerPanel
          answer={{
            phase: 'completed',
            text: 'Revenue increased.',
            citations: [{fileId: 'report', label: 'Report.pdf', page: 4}],
            provider: 'openai',
            model: 'gpt-5.4-mini',
            route: 'lumen.answer.cloud',
          }}
          mode="cloud"
          onModeChange={onModeChange}
          onOpenCitation={vi.fn()}
          onRetry={vi.fn()}
          onStop={vi.fn()}
        />
      </AppProviders>,
    );

    expect(screen.getByText('Revenue increased.')).toBeInTheDocument();
    expect(screen.getByText(/openai · gpt-5.4-mini/)).toBeInTheDocument();
    expect(screen.getByRole('radio', {name: 'Cloud'})).toBeChecked();
    expect(screen.getByRole('button', {name: 'Open Report.pdf, page 4'})).toBeInTheDocument();

    await user.click(screen.getByRole('radio', {name: 'Local'}));
    expect(onModeChange).toHaveBeenCalledWith('local');
  });

  it('offers a stop action while an answer is streaming', async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();

    render(
      <AppProviders>
        <AnswerPanel
          answer={{phase: 'streaming', text: 'Partial', citations: []}}
          mode="auto"
          onModeChange={vi.fn()}
          onOpenCitation={vi.fn()}
          onRetry={vi.fn()}
          onStop={onStop}
        />
      </AppProviders>,
    );

    await user.click(screen.getByRole('button', {name: 'Stop answer'}));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it('preserves the typed service error in the stable answer region', () => {
    render(
      <AppProviders>
        <AnswerPanel
          answer={{
            phase: 'error',
            text: '',
            citations: [],
            error: 'The local runtime is still loading.',
          }}
          mode="local"
          onModeChange={vi.fn()}
          onOpenCitation={vi.fn()}
          onRetry={vi.fn()}
          onStop={vi.fn()}
        />
      </AppProviders>,
    );

    expect(screen.getByTestId('answer-region')).toHaveTextContent(
      'The local runtime is still loading.',
    );
  });

  it.each(['waiting', 'streaming'] as const)(
    'keeps stop available while the answer is %s',
    (phase) => {
      render(
        <AppProviders>
          <AnswerPanel
            answer={{phase, text: '', citations: []}}
            mode="auto"
            onModeChange={vi.fn()}
            onOpenCitation={vi.fn()}
            onRetry={vi.fn()}
            onStop={vi.fn()}
          />
        </AppProviders>,
      );

      expect(screen.getByRole('button', {name: 'Stop answer'})).toBeEnabled();
    },
  );

  it.each(['error', 'cancelled', 'completed'] as const)(
    'offers retry after the answer is %s',
    (phase) => {
      render(
        <AppProviders>
          <AnswerPanel
            answer={{phase, text: phase === 'completed' ? 'Done.' : '', citations: []}}
            mode="auto"
            onModeChange={vi.fn()}
            onOpenCitation={vi.fn()}
            onRetry={vi.fn()}
            onStop={vi.fn()}
          />
        </AppProviders>,
      );

      expect(screen.getByRole('button', {name: 'Retry answer'})).toBeEnabled();
    },
  );

  it('updates streaming deltas in one stable answer region', () => {
    const props = {
      mode: 'auto' as const,
      onModeChange: vi.fn(),
      onOpenCitation: vi.fn(),
      onRetry: vi.fn(),
      onStop: vi.fn(),
    };
    const {rerender} = render(
      <AppProviders>
        <AnswerPanel answer={{phase: 'streaming', text: 'First delta.', citations: []}} {...props} />
      </AppProviders>,
    );

    const region = screen.getByTestId('answer-region');
    rerender(
      <AppProviders>
        <AnswerPanel answer={{phase: 'streaming', text: 'First delta. Second delta.', citations: []}} {...props} />
      </AppProviders>,
    );

    expect(screen.getByTestId('answer-region')).toBe(region);
    expect(region).toHaveTextContent('First delta. Second delta.');
  });

  it('keeps citations as buttons that open their backing file IDs', async () => {
    const user = userEvent.setup();
    const onOpenCitation = vi.fn();
    render(
      <AppProviders>
        <AnswerPanel
          answer={{
            phase: 'completed',
            text: 'Grounded answer.',
            citations: [{fileId: 'meeting-notes', label: 'Meeting notes.md'}],
          }}
          mode="auto"
          onModeChange={vi.fn()}
          onOpenCitation={onOpenCitation}
          onRetry={vi.fn()}
          onStop={vi.fn()}
        />
      </AppProviders>,
    );

    await user.click(screen.getByRole('button', {name: 'Open Meeting notes.md'}));
    expect(onOpenCitation).toHaveBeenCalledWith('meeting-notes');
  });

  it('shows preparation while awaiting the first token', () => {
    render(<AppProviders><AnswerPanel answer={{phase: 'waiting', text: '', citations: []}} mode="local"
      onModeChange={vi.fn()} onOpenCitation={vi.fn()} onRetry={vi.fn()} onStop={vi.fn()} /></AppProviders>);
    expect(screen.getByTestId('answer-region')).toHaveTextContent('Preparing an answer');
    expect(screen.queryByText(/settling|query to settle/i)).not.toBeInTheDocument();
  });

  it('shows stopped in the answer region when cancelled before tokens', () => {
    render(<AppProviders><AnswerPanel answer={{phase: 'cancelled', text: '', citations: []}} mode="local"
      onModeChange={vi.fn()} onOpenCitation={vi.fn()} onRetry={vi.fn()} onStop={vi.fn()} /></AppProviders>);
    expect(screen.getByTestId('answer-region')).toHaveTextContent('Stopped');
  });

  it('keeps the error visible alongside partial text and source controls', () => {
    render(<AppProviders><AnswerPanel answer={{phase: 'error', text: 'Partial answer', error: 'The answer ended early.',
      citations: [{fileId: 'f', label: 'File'}], provider: 'local'}} mode="local"
      onModeChange={vi.fn()} onOpenCitation={vi.fn()} onRetry={vi.fn()} onStop={vi.fn()} /></AppProviders>);
    expect(screen.getByTestId('answer-region')).toHaveTextContent('Partial answer');
    expect(screen.getByRole('status')).toHaveTextContent('The answer ended early.');
    expect(screen.getByRole('button', {name: 'Open File'})).toBeEnabled();
    expect(screen.getByText('local')).toBeInTheDocument();
  });
});

