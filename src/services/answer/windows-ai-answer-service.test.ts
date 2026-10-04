import {describe, expect, it, vi} from 'vitest';
import {WindowsAiAnswerService} from './windows-ai-answer-service';
import {UnavailableWindowsAiService, unsupportedWindowsAiSnapshot} from '../windows-ai/unavailable-windows-ai-service';
import {defaultWindowsAiPreferences} from '../windows-ai/windows-ai.types';
import type {AnswerService} from './answer-service';
import type {AnswerEvent} from './answer.types';

async function collect(events: AsyncIterable<AnswerEvent>) { const result: AnswerEvent[] = []; for await (const event of events) result.push(event); return result; }

const fallback: AnswerService = {stream: vi.fn(async function* () { yield {type: 'completed', provider: 'runtime', model: 'local', route: 'local'} as const; })};
describe('answer engine routing', () => {
  it('keeps automatic local runtime answers when Windows AI is unavailable', async () => {
    const service = new WindowsAiAnswerService(fallback, new UnavailableWindowsAiService(), () => unsupportedWindowsAiSnapshot());
    const result = await collect(service.stream({requestId: 1, query: 'hello', mode: 'local', cloudConsent: false}, new AbortController().signal));
    expect(result[result.length - 1]).toMatchObject({provider: 'runtime'});
  });
  it('does not silently route an unavailable explicitly selected preview engine to cloud', async () => {
    const snapshot = unsupportedWindowsAiSnapshot({...defaultWindowsAiPreferences, localEngine: 'aion'});
    const service = new WindowsAiAnswerService(fallback, new UnavailableWindowsAiService(), () => snapshot);
    const result = await collect(service.stream({requestId: 1, query: 'hello', mode: 'auto', cloudConsent: true}, new AbortController().signal));
    expect(result).toEqual([expect.objectContaining({type: 'failed'})]);
  });
});
