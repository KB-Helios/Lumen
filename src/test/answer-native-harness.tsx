import {Channel} from '@tauri-apps/api/core';
import {mockIPC} from '@tauri-apps/api/mocks';
import {Profiler, useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';

import '../design-system/global.css';
import {AnswerPanel} from '../features/answer/AnswerPanel';
import {useAnswerController, type AnswerState} from '../features/answer/useAnswerController';
import type {AnswerEvent, AnswerRequest, RuntimeMode} from '../services/answer/answer.types';
import {TauriAnswerService} from '../services/answer/tauri-answer-service';

interface HarnessMetrics {
  commits: number;
  renderMs: number;
  callbackMs: number;
  nativeEvents: number;
  submittedAt: number;
  firstRenderedTokenMs?: number;
  snapshots: AnswerState[];
}
interface Harness {
  submit(query: string, mode?: RuntimeMode): void;
  state: AnswerState;
  metrics: HarnessMetrics;
}
type TestWindow = Window & {
  __LUMEN_ANSWER_HARNESS__?: Harness;
  __TAURI_INTERNALS__: {runCallback(id: number, message: unknown): void};
};
const testWindow = window as unknown as TestWindow;
const parameters = new URLSearchParams(window.location.search);
const bridge = parameters.get('bridge');
const token = parameters.get('token');
if (!import.meta.env.DEV || !bridge || !/^http:\/\/127\.0\.0\.1:\d+$/.test(bridge) || !token) {
  throw new Error('Native answer integration requires an explicit local development bridge.');
}
const bridgeUrl = bridge;
const bridgeToken = token;
const service = new TauriAnswerService();
const metrics: HarnessMetrics = {commits: 0, renderMs: 0, callbackMs: 0, nativeEvents: 0, submittedAt: 0, snapshots: []};
const streams = new Map<number, AbortController>();

mockIPC(async (command, args) => {
  const payload = args as Record<string, unknown> | undefined;
  const headers = {'content-type': 'application/json', 'x-lumen-test-token': bridgeToken};
  if (command === 'cancel_answer') {
    const requestId = payload?.requestId as number;
    try {
      await fetch(`${bridgeUrl}/cancel`, {method: 'POST', headers, body: JSON.stringify({requestId})});
    } finally { streams.get(requestId)?.abort(); }
    return;
  }
  if (command !== 'start_answer') throw new Error('Unsupported integration command.');
  const request = payload?.request as AnswerRequest;
  const channel = payload?.onEvent as Channel<AnswerEvent>;
  const abort = new AbortController();
  streams.set(request.requestId, abort);
  let index = 0;
  try {
    const response = await fetch(`${bridgeUrl}/start`, {method: 'POST', headers, body: JSON.stringify(request), signal: abort.signal});
    if (!response.ok || !response.body) throw new Error('Native integration bridge unavailable.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let buffer = '';
    let done = false;
    while (!done) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, {stream: !chunk.done});
      if (buffer.length > 256 * 1024) throw new Error('Integration record exceeds test limit.');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline)) as {requestId: number; event?: unknown; done?: boolean; error?: string};
        buffer = buffer.slice(newline + 1);
        if (message.requestId !== request.requestId) throw new Error('Integration request identity mismatch.');
        if (message.event) {
          const started = performance.now();
          testWindow.__TAURI_INTERNALS__.runCallback(channel.id, {index: index++, message: message.event});
          metrics.callbackMs += performance.now() - started;
          metrics.nativeEvents++;
        }
        if (message.done) { done = true; if (message.error) throw new Error('Native fixture failed.'); }
      }
      if (chunk.done) { if (!done) throw new Error('Native integration ended without done.'); break; }
    }
    await reader.cancel();
  } catch (error) {
    if (!abort.signal.aborted) throw error;
  } finally {
    testWindow.__TAURI_INTERNALS__.runCallback(channel.id, {index, end: true});
    streams.delete(request.requestId);
  }
});

function HarnessPanel() {
  const [submission, setSubmission] = useState({query: '', mode: 'auto' as RuntimeMode, revision: 0});
  const answer = useAnswerController(service, {...submission, cloudConsent: true, delayMs: 0, restartKey: submission.revision});
  useEffect(() => {
    testWindow.__LUMEN_ANSWER_HARNESS__ = {
      submit(query, mode = 'auto') {
        metrics.submittedAt = performance.now();
        metrics.firstRenderedTokenMs = undefined;
        metrics.commits = 0;
        metrics.renderMs = 0;
        metrics.callbackMs = 0;
        metrics.nativeEvents = 0;
        metrics.snapshots = [];
        setSubmission((current) => ({query, mode, revision: current.revision + 1}));
      },
      state: {phase: answer.phase, text: answer.text, citations: answer.citations, usage: answer.usage,
        provider: answer.provider, model: answer.model, route: answer.route, error: answer.error},
      metrics,
    };
    if (metrics.snapshots.length < 1100) metrics.snapshots.push({...answer});
    if (answer.text && metrics.nativeEvents > 0 && metrics.firstRenderedTokenMs === undefined) metrics.firstRenderedTokenMs = performance.now() - metrics.submittedAt;
  }, [answer]);
  return <AnswerPanel answer={answer} mode={submission.mode}
    onModeChange={(mode) => setSubmission((current) => ({...current, mode}))}
    onOpenCitation={() => undefined} onRetry={answer.retry} onStop={answer.stop} />;
}

createRoot(document.getElementById('root')!).render(
  <Profiler id="native-answer" onRender={(_id, _phase, duration) => { metrics.commits++; metrics.renderMs += duration; }}>
    <HarnessPanel />
  </Profiler>,
);
