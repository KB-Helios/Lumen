import {useEffect, useState} from 'react';

import {LumenUiIcon} from '../../design-system/icons/LumenUiIcon';
import type {RuntimeMode} from '../../services/answer/answer.types';
import type {AnswerState} from './useAnswerController';
import {RuntimeModeSwitch} from './RuntimeModeSwitch';

function statusLabel(answer: AnswerState) {
  if (answer.phase === 'idle') return 'Ready when submitted';
  if (answer.phase === 'waiting') return 'Settling query';
  if (answer.phase === 'streaming') return 'Answering';
  if (answer.phase === 'error') return 'Answer unavailable';
  if (answer.phase === 'cancelled') return 'Stopped';
  return 'Ready';
}

function citationLabel(label: string, page?: number, timestampSeconds?: number) {
  if (page !== undefined) return `${label}, page ${page}`;
  if (timestampSeconds !== undefined) {
    const minutes = Math.floor(timestampSeconds / 60);
    const seconds = Math.floor(timestampSeconds % 60).toString().padStart(2, '0');
    return `${label}, ${minutes}:${seconds}`;
  }
  return label;
}

const quietButtonClass = 'inline-flex min-h-[32px] min-w-[32px] items-center justify-center gap-[6px] rounded-control px-[8px] font-sans text-xs text-[color:var(--einui-command-muted-text)] outline-none transition-colors duration-[var(--lumen-duration-hover)] hover:bg-[var(--einui-command-row-hover)] hover:text-[color:var(--einui-command-text)] focus-visible:ring-2 focus-visible:ring-[var(--lumen-focus)] disabled:cursor-not-allowed disabled:opacity-55';

export interface AnswerPanelProps {
  answer: AnswerState;
  mode: RuntimeMode;
  onModeChange(mode: RuntimeMode): void;
  onOpenCitation(fileId: string): void;
  onRetry(): void;
  onStop(): void;
}

export function AnswerPanel({
  answer,
  mode,
  onModeChange,
  onOpenCitation,
  onRetry,
  onStop,
}: AnswerPanelProps) {
  const [copied, setCopied] = useState(false);
  const canStop = answer.phase === 'waiting' || answer.phase === 'streaming';
  const canRetry = answer.phase === 'error' || answer.phase === 'cancelled' || answer.phase === 'completed';
  const hasAnswer = answer.text.length > 0;
  const runtimeDetail = [answer.provider, answer.model, answer.route].filter(Boolean).join(' · ');

  const copyAnswer = async () => {
    await navigator.clipboard.writeText(answer.text);
    setCopied(true);
  };

  useEffect(() => {
    setCopied(false);
  }, [answer.text]);

  return (
    <section aria-label="AI answer" className="lumen-answer-panel @container/answer min-w-0 border-b border-[color:var(--einui-command-divider)]">
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-[8px]">
        <div className="flex min-w-0 items-baseline gap-[8px]">
          <span className="whitespace-nowrap font-sans text-xs font-medium text-[color:var(--einui-command-text)]">AI answer</span>
          <span className="truncate font-sans text-[0.6875rem] text-[color:var(--einui-command-muted-text)] @max-[560px]/answer:sr-only">{statusLabel(answer)}</span>
        </div>
        <div className="flex min-w-0 items-center gap-[4px]">
          <RuntimeModeSwitch mode={mode} onChange={onModeChange} />
          {canStop ? (
            <button aria-label="Stop answer" className={quietButtonClass} type="button" onClick={onStop}><LumenUiIcon name="stop" size="small" /><span className="hidden @min-[560px]/answer:inline">Stop</span></button>
          ) : canRetry ? (
            <button aria-label="Retry answer" className={quietButtonClass} type="button" onClick={onRetry}><LumenUiIcon name="retry" size="small" /><span className="hidden @min-[560px]/answer:inline">Retry</span></button>
          ) : null}
          {hasAnswer ? (
            <button aria-label={copied ? 'Answer copied' : 'Copy answer'} className={quietButtonClass} type="button" onClick={() => void copyAnswer()}><LumenUiIcon name={copied ? 'approval' : 'copy'} size="small" /><span className="hidden @min-[560px]/answer:inline">{copied ? 'Copied' : 'Copy'}</span></button>
          ) : null}
        </div>
      </header>
      <div
        aria-live="polite"
        className="lumen-answer-text overflow-y-auto whitespace-pre-wrap font-sans text-sm leading-relaxed text-[color:var(--einui-command-text)]"
        data-testid="answer-region"
      >
        {answer.phase === 'idle' ? null : hasAnswer
          ? answer.text
          : answer.phase === 'waiting'
            ? 'Waiting for the query to settle…'
            : answer.phase === 'error'
              ? answer.error ?? 'The answer could not be completed. You can retry without interrupting local search.'
              : 'Preparing an answer…'}
      </div>
      {answer.citations.length > 0 || runtimeDetail ? <footer className="flex min-w-0 flex-wrap items-center justify-between gap-[8px]">
        <div aria-label="Answer sources" className="flex min-w-0 flex-wrap gap-[6px]">
          {answer.citations.map((citation) => {
            const label = citationLabel(citation.label, citation.page, citation.timestampSeconds);
            return (
              <button
                key={`${citation.fileId}-${citation.page ?? citation.timestampSeconds ?? 'file'}`}
                aria-label={`Open ${label}`}
                className="min-h-[32px] max-w-full rounded-pill border border-[color:var(--einui-command-divider)] bg-[var(--einui-command-row)] px-[8px] font-sans text-[0.6875rem] text-accent outline-none transition-colors duration-[var(--lumen-duration-hover)] hover:bg-[var(--einui-command-row-hover)] focus-visible:ring-2 focus-visible:ring-focus"
                type="button"
                onClick={() => onOpenCitation(citation.fileId)}
              >
                {label}
              </button>
            );
          })}
        </div>
          {runtimeDetail ? (
            <details className="lumen-runtime-details relative">
              <summary className={`${quietButtonClass} cursor-default list-none [&::-webkit-details-marker]:hidden`}>Runtime details</summary>
              <div className="lumen-runtime-popover absolute bottom-full right-0 z-30 mb-[4px] w-max max-w-[min(320px,80cqw)] break-words rounded-control border border-[color:var(--einui-command-divider)] bg-[var(--lumen-surface-raised)] px-[8px] py-[6px] font-sans text-[0.6875rem] text-text-secondary shadow-control">
                {runtimeDetail}
              </div>
            </details>
          ) : null}
      </footer> : null}
    </section>
  );
}
