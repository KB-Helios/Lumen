import {Channel, invoke} from '@tauri-apps/api/core';

import type {AnswerService} from './answer-service';
import {answerDeliverySchema, answerEventSchema, isTerminalAnswerEvent, maxAnswerEvents, maxAnswerQueuedEvents, maxAnswerStreamBytes, maxAnswerTextBytes, type AnswerEvent, type AnswerRequest} from './answer.types';

const failureMessages: Record<string, string> = {
  rate_limited: 'The answer provider is rate limited. Retry later or select Local.',
  provider_unavailable: 'The answer provider is unavailable. Retry the request or select another runtime.',
  provider_unauthorized: 'The answer provider could not authenticate. Check AgentGateway settings.',
  invalid_response: 'The answer provider returned an invalid response. Retry the request.',
  incomplete_response: 'The answer ended before it was complete. Retry the request.',
  response_too_large: 'The answer exceeded its size limit. Try a shorter request.',
  header_timeout: 'The answer provider did not respond in time. Retry the request.',
  stream_timeout: 'The answer provider stopped responding. Retry the request.',
  request_timeout: 'The answer request exceeded its time limit. Retry the request.',
  local_runtime_unavailable: 'The local answer runtime is unavailable. Check Local AI settings.',
  context_unavailable: 'Local answer sources could not be read. Retry the request.',
  cloud_consent_required: 'Cloud answers require explicit consent in AgentGateway settings.',
  cloud_credential_required: 'Cloud answers require a configured provider credential.',
  route_unavailable: 'The requested answer route is not configured.',
  invalid_request: 'The answer request is invalid or too large.',
};

/** Replaces untrusted native error text with fixed guidance for known failure codes. */
function safeFailure(event: Extract<AnswerEvent, {type: 'failed'}>): AnswerEvent {
  const code = event.code && Object.prototype.hasOwnProperty.call(failureMessages, event.code) ? event.code : 'answer-failed';
  return {type: 'failed', code, message: failureMessages[code] ?? 'The answer could not be generated. Retry the request.'};
}

export class TauriAnswerService implements AnswerService {
  /** Yields bounded, validated native events until a terminal event; drains acknowledged delivery and cancels unfinished work on disposal. */
  async *stream(request: AnswerRequest, signal: AbortSignal): AsyncIterable<AnswerEvent> {
    if (signal.aborted) return;
    const queued: AnswerEvent[] = [];
    const encoder = new TextEncoder();
    let wake: (() => void) | undefined;
    let acknowledgedEvents: number | undefined;
    let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
    let terminalReceived = false;
    let disposed = false;
    let cancelled = false;
    let outputBytes = 0;
    let queuedBytes = 0;
    let streamBytes = 0;
    let eventCount = 0;
    let failure: Error | undefined;
    /** Wakes the waiting consumer once and clears its resolver. */
    const notify = () => { wake?.(); wake = undefined; };
    /** Sends at most one native Stop for this request and wakes the consumer. */
    const cancel = () => {
      if (!cancelled) {
        cancelled = true;
        void invoke('cancel_answer', {requestId: request.requestId}).catch(() => undefined);
      }
      notify();
    };
    /** Discards buffered events, records a safe error, and cancels the owned request. */
    const reject = (message: string) => {
      failure = new Error(message);
      queued.length = 0;
      queuedBytes = 0;
      cancel();
    };
    const channel = new Channel<unknown>((payload) => {
      if (disposed || terminalReceived || failure || signal.aborted) return;
      const parsed = answerEventSchema.safeParse(payload);
      if (!parsed.success) { reject('The answer service sent an invalid event. Retry the request.'); return; }
      const event = parsed.data.type === 'failed' ? safeFailure(parsed.data) : parsed.data;
      if (event.type === 'started') outputBytes = 0;
      if (event.type === 'delta') outputBytes += encoder.encode(event.text).byteLength;
      const size = encoder.encode(JSON.stringify(event)).byteLength;
      streamBytes += size;
      eventCount += 1;
      if (acknowledgedEvents !== undefined && eventCount > acknowledgedEvents) {
        reject('The answer service sent an invalid acknowledgement. Retry the request.');
        return;
      }
      if (outputBytes > maxAnswerTextBytes || queuedBytes + size > maxAnswerTextBytes
        || streamBytes > maxAnswerStreamBytes || queued.length >= maxAnswerQueuedEvents || eventCount > maxAnswerEvents) {
        reject('The answer exceeded its size or buffer limit. Retry the request.');
        return;
      }
      queuedBytes += size;
      terminalReceived = isTerminalAnswerEvent(event);
      if (terminalReceived) {
        clearTimeout(requestTimer);
        clearTimeout(deliveryTimer);
      }
      queued.push(event);
      notify();
    });
    // Install deadlines only after Channel registration succeeds. Native work
    // has a 120 s deadline; command resolution is not a Channel ordering barrier.
    const requestTimer = setTimeout(() => {
      reject('The answer request exceeded its time limit. Retry the request.');
    }, 125_000);
    signal.addEventListener('abort', cancel, {once: true});
    void invoke<unknown>('start_answer', {request, onEvent: channel}).then((payload) => {
      if (disposed || terminalReceived || failure || signal.aborted) return;
      const parsed = answerDeliverySchema.safeParse(payload);
      if (!parsed.success || parsed.data.eventCount < eventCount) {
        reject('The answer service sent an invalid acknowledgement. Retry the request.');
        return;
      }
      acknowledgedEvents = parsed.data.eventCount;
      deliveryTimer = setTimeout(() => {
        reject('The answer service exceeded its delivery time limit. Retry the request.');
      }, 5000);
      notify();
    }, () => {
      if (!terminalReceived && !signal.aborted && !disposed && !failure) {
        reject('The answer service could not start or finish the request. Retry the request.');
      }
      notify();
    });

    try {
      while (true) {
        if (signal.aborted) return;
        if (failure) throw failure;
        const event = queued.shift();
        if (event) {
          queuedBytes -= encoder.encode(JSON.stringify(event)).byteLength;
          yield event;
          if (isTerminalAnswerEvent(event)) return;
        } else if (acknowledgedEvents !== undefined && eventCount >= acknowledgedEvents) {
          throw new Error('The answer ended before it was complete. Retry the request.');
        } else {
          await new Promise<void>((resolve) => { wake = resolve; });
        }
      }
    } finally {
      disposed = true;
      clearTimeout(requestTimer);
      clearTimeout(deliveryTimer);
      queued.length = 0;
      channel.onmessage = () => undefined;
      signal.removeEventListener('abort', cancel);
      if (!terminalReceived) cancel();
    }
  }
}
