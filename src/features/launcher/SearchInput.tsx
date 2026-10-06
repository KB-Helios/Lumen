import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type FormEvent,
  type KeyboardEvent,
} from 'react';

import {LumenUiIcon} from '../../design-system/icons/LumenUiIcon';
import {LumenIconButton} from '../../design-system/primitives/LumenIconButton';
import {captureTiming} from '../diagnostics/diagnostics.metrics';
import {useQueryStore} from './query.store';
import type {LauncherIntent} from './launcher.store';

export interface SearchInputProps {
  intent?: LauncherIntent;
  onEscapeEmpty(): void;
  onSubmit?(task: string): void;
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  function SearchInput({intent = 'search', onEscapeEmpty, onSubmit}, ref) {
    const setDraft = useQueryStore((state) => state.setDraft);
    const startComposition = useQueryStore((state) => state.startComposition);
    const endComposition = useQueryStore((state) => state.endComposition);
    const submit = useQueryStore((state) => state.submit);
    const clear = useQueryStore((state) => state.clear);
    const inputRef = useRef<HTMLInputElement>(null);
    const clearWrapperRef = useRef<HTMLSpanElement>(null);
    const pendingFrame = useRef(0);
    const pendingTimer = useRef(0);

    useImperativeHandle(ref, () => inputRef.current as HTMLInputElement, []);

    useEffect(() => {
      const syncDraft = (value: string) => {
        if (inputRef.current && inputRef.current.value !== value) {
          inputRef.current.value = value;
        }
        if (clearWrapperRef.current) {
          clearWrapperRef.current.hidden = value.length === 0;
        }
      };
      syncDraft(useQueryStore.getState().draft);
      return useQueryStore.subscribe((state) => state.draft, syncDraft);
    }, []);

    useEffect(() => () => {
      window.cancelAnimationFrame(pendingFrame.current);
      window.clearTimeout(pendingTimer.current);
    }, []);

    const cancelPendingCommit = () => {
      window.cancelAnimationFrame(pendingFrame.current);
      window.clearTimeout(pendingTimer.current);
    };

    const commitAfterInputPaint = (value: string) => {
      cancelPendingCommit();
      pendingFrame.current = window.requestAnimationFrame(() => {
        pendingTimer.current = window.setTimeout(() => setDraft(value), 0);
      });
    };

    const clearInput = () => {
      cancelPendingCommit();
      if (inputRef.current) {
        inputRef.current.value = '';
      }
      if (clearWrapperRef.current) {
        clearWrapperRef.current.hidden = true;
      }
      clear();
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter' && intent === 'computer' && !event.nativeEvent.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        const task = inputRef.current?.value ?? '';
        cancelPendingCommit();
        setDraft(task);
        onSubmit?.(task);
        return;
      }
      if (event.key === 'Enter' && intent === 'search' &&
        !event.nativeEvent.isComposing && !useQueryStore.getState().isComposing) {
        event.preventDefault();
        event.stopPropagation();
        const query = inputRef.current?.value ?? '';
        cancelPendingCommit();
        setDraft(query);
        submit();
        return;
      }
      if (event.key !== 'Escape') {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (inputRef.current?.value) {
        clearInput();
      } else {
        onEscapeEmpty();
      }
    };

    const handleInput = (event: FormEvent<HTMLInputElement>) => {
      const startedAt = performance.now();
      const value = event.currentTarget.value;
      if (clearWrapperRef.current) {
        clearWrapperRef.current.hidden = value.length === 0;
      }
      captureTiming('input-response', performance.now() - startedAt);
      commitAfterInputPaint(value);
    };

    const handleCompositionEnd = () => {
      cancelPendingCommit();
      setDraft(inputRef.current?.value ?? '');
      endComposition();
    };

    return (
      <div
        aria-label={intent === 'computer' ? 'Browser task' : 'File search'}
        className="-mx-1 flex min-w-0 flex-1 items-center gap-1 rounded-[var(--lumen-radius-control)] bg-transparent px-1 py-1 shadow-[inset_0_-1px_0_transparent] transition-[background-color,box-shadow] duration-[90ms] ease-standard focus-within:bg-[var(--einui-command-row)] focus-within:shadow-[inset_0_-1px_0_var(--lumen-focus)]"
        role="search"
      >
        <input
          ref={inputRef}
          aria-label={intent === 'computer' ? 'Describe a computer task' : 'Search files'}
          autoCapitalize="off"
          autoComplete="off"
          defaultValue={useQueryStore.getState().draft}
          enterKeyHint="search"
          placeholder={intent === 'computer' ? 'Describe browser task' : 'Search apps and files'}
          spellCheck={false}
          type="search"
          className="min-w-0 flex-1 border-0 bg-transparent p-0 font-sans text-[1.0625rem] font-normal leading-tight tracking-tight text-[color:var(--einui-command-text)] caret-accent outline-none placeholder:text-[color:var(--einui-command-muted-text)]"
          onCompositionEnd={handleCompositionEnd}
          onCompositionStart={startComposition}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
        />
        <span ref={clearWrapperRef} hidden={!useQueryStore.getState().draft}>
          <LumenIconButton
            aria-label="Clear search"
            className="shrink-0 text-[color:var(--einui-command-muted-text)]"
            size="small"
            variant="quiet"
            onPress={clearInput}
          >
            <LumenUiIcon name="close" size="small" />
          </LumenIconButton>
        </span>
      </div>
    );
  },
);
