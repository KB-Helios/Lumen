import {useCallback, useEffect, useRef, useState} from 'react';

import type {AnswerService} from '../../services/answer/answer-service';
import type {
  AnswerCitation,
  AnswerEvent,
  AnswerUsage,
  RuntimeMode,
} from '../../services/answer/answer.types';

export type AnswerPhase = 'idle' | 'waiting' | 'streaming' | 'completed' | 'cancelled' | 'error';

export interface AnswerState {
  phase: AnswerPhase;
  text: string;
  citations: readonly AnswerCitation[];
  usage?: AnswerUsage;
  provider?: string;
  model?: string;
  route?: string;
  error?: string;
}

export interface AnswerController extends AnswerState {
  stop(): void;
  retry(): void;
}

interface AnswerControllerOptions {
  query: string;
  mode: RuntimeMode;
  cloudConsent?: boolean;
  delayMs?: number;
  restartKey?: number;
}

const idleState: AnswerState = {
  phase: 'idle',
  text: '',
  citations: [],
};

let nextRequestId = Date.now() * 1000;

function isTerminal(phase: AnswerPhase): boolean {
  return phase === 'completed' || phase === 'cancelled' || phase === 'error';
}

function applyEvent(state: AnswerState, event: AnswerEvent): AnswerState {
  if (isTerminal(state.phase)) return state;
  switch (event.type) {
    case 'started':
      return {phase: 'waiting', text: '', citations: state.citations, provider: event.provider, model: event.model, route: event.route};
    case 'citation':
      return state.citations.some((citation) =>
        citation.fileId === event.citation.fileId
        && citation.page === event.citation.page
        && citation.timestampSeconds === event.citation.timestampSeconds
      ) ? state : {...state, citations: [...state.citations, event.citation]};
    case 'delta':
      return event.text ? {...state, phase: 'streaming', text: state.text + event.text} : state;
    case 'usage':
      return {...state, usage: event.usage};
    case 'completed':
      return {
        ...state,
        phase: 'completed',
        provider: event.provider,
        model: event.model,
        route: event.route,
      };
    case 'cancelled':
      return {...state, phase: 'cancelled'};
    case 'failed':
      return {...state, phase: 'error', error: event.message};
  }
}

export function useAnswerController(
  service: AnswerService,
  {query, mode, cloudConsent = false, delayMs = 350, restartKey = 0}: AnswerControllerOptions,
): AnswerController {
  const [state, setState] = useState<AnswerState>(idleState);
  const [retryRevision, setRetryRevision] = useState(0);
  const sequence = useRef(0);
  const activeAbort = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    sequence.current += 1;
    activeAbort.current?.abort();
    setState((current) => {
      if (current.phase === 'idle' || isTerminal(current.phase)) return current;
      return {...current, phase: 'cancelled'};
    });
  }, []);

  const retry = useCallback(() => {
    sequence.current += 1;
    activeAbort.current?.abort();
    setRetryRevision((current) => current + 1);
  }, []);

  useEffect(() => {
    const normalizedQuery = query.trim();
    const currentSequence = ++sequence.current;

    if (!normalizedQuery) {
      setState(idleState);
      return;
    }

    const abortController = new AbortController();
    activeAbort.current = abortController;
    setState({phase: 'waiting', text: '', citations: []});

    const timeout = window.setTimeout(() => {
      if (abortController.signal.aborted || sequence.current !== currentSequence) {
        return;
      }

      void (async () => {
        try {
          const events = service.stream({
            requestId: ++nextRequestId,
            query: normalizedQuery,
            mode,
            cloudConsent,
          }, abortController.signal);
          for await (const event of events) {
            if (abortController.signal.aborted || sequence.current !== currentSequence) {
              return;
            }
            setState((current) => sequence.current === currentSequence && !abortController.signal.aborted
              ? applyEvent(current, event) : current);
            if (event.type === 'completed' || event.type === 'failed' || event.type === 'cancelled') return;
          }
          if (!abortController.signal.aborted && sequence.current === currentSequence) {
            setState((current) => sequence.current === currentSequence && !abortController.signal.aborted && !isTerminal(current.phase)
              ? {...current, phase: 'error', error: 'The answer ended before it was complete. Retry the request.'} : current);
          }
        } catch {
          if (!abortController.signal.aborted && sequence.current === currentSequence) {
            setState((current) => sequence.current === currentSequence && !abortController.signal.aborted && !isTerminal(current.phase) ? ({
              ...current,
              phase: 'error',
              error: 'Answer generation failed. Retry the request.',
            }) : current);
          }
        }
      })();
    }, delayMs);

    return () => {
      window.clearTimeout(timeout);
      abortController.abort();
      if (activeAbort.current === abortController) {
        activeAbort.current = null;
      }
    };
  }, [cloudConsent, delayMs, mode, query, restartKey, retryRevision, service]);

  return {...state, retry, stop};
}
