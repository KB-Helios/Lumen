import {beforeEach, describe, expect, it, vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';

import {TauriWindowsAiService} from './tauri-windows-ai-service';
import {unsupportedWindowsAiSnapshot} from './unavailable-windows-ai-service';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class { onmessage?: (event: unknown) => void; },
}));
vi.mock('@tauri-apps/api/event', () => ({listen: vi.fn(async () => () => undefined)}));

describe('native Windows AI boundary', () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it('rejects malformed native readiness instead of accepting a false ready state', async () => {
    vi.mocked(invoke).mockResolvedValue({version: 1, features: [{id: 'languageModel', availability: 'ready'}]});
    await expect(new TauriWindowsAiService().status()).rejects.toThrow();
  });

  it('parses a complete native snapshot', async () => {
    vi.mocked(invoke).mockResolvedValue(unsupportedWindowsAiSnapshot());
    expect((await new TauriWindowsAiService().status()).host.packageIdentity).toBe(false);
  });

  it('ignores events from another request and validates the terminal result', async () => {
    const listener = vi.fn();
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
      if (_command !== 'windows_ai_text') return undefined;
      const channel = (args as Record<string, unknown>).onEvent as {onmessage(event: unknown): void};
      channel.onmessage({type: 'delta', requestId: 'old', text: 'stale'});
      channel.onmessage({type: 'delta', requestId: 'task-1', text: 'hello'});
      return {text: 'hello', engine: 'windows', model: null, citations: []};
    });
    const result = await new TauriWindowsAiService().text({requestId: 'task-1', engine: 'windows', task: 'answer', text: 'question'}, listener);
    expect(result.text).toBe('hello');
    expect(listener).toHaveBeenCalledExactlyOnceWith({type: 'delta', requestId: 'task-1', text: 'hello'});
  });

  it('does not start an already cancelled operation', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(new TauriWindowsAiService().text({requestId: 'task-1', engine: 'windows', task: 'answer', text: 'question'}, undefined, abort.signal)).rejects.toMatchObject({name: 'AbortError'});
    expect(invoke).not.toHaveBeenCalled();
  });
});
