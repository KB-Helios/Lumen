import {z} from 'zod';

export type RuntimeMode = 'auto' | 'local' | 'cloud';

export interface AnswerRequest {
  requestId: number;
  query: string;
  mode: RuntimeMode;
  cloudConsent: boolean;
  workflowRunId?: string;
}

export interface AnswerCitation {
  fileId: string;
  label: string;
  page?: number;
  timestampSeconds?: number;
}

export interface AnswerUsage {
  inputTokens: number;
  outputTokens: number;
  remainingTokens?: number;
  resetAt?: string;
}

export type AnswerEvent =
  | {type: 'started'; provider?: string; model?: string; route?: string}
  | {type: 'citation'; citation: AnswerCitation}
  | {type: 'delta'; text: string}
  | {type: 'usage'; usage: AnswerUsage}
  | {type: 'completed'; provider: string; model: string; route: string}
  | {type: 'cancelled'}
  | {type: 'failed'; message: string; code?: string};

export const maxAnswerTextBytes = 1024 * 1024;
export const maxAnswerStreamBytes = 4 * 1024 * 1024;
export const maxAnswerQueuedEvents = 4096;
export const maxAnswerEvents = 32768;
export const answerDeliverySchema = z.strictObject({eventCount: z.number().int().nonnegative().max(maxAnswerEvents)});
const attribution = z.string().min(1).max(512);
const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const answerCitationSchema = z.strictObject({
  fileId: z.string().min(1).max(4096),
  label: z.string().min(1).max(1024),
  page: tokenCount.optional(),
  timestampSeconds: z.number().nonnegative().optional(),
});
export const answerEventSchema = z.discriminatedUnion('type', [
  z.strictObject({type: z.literal('started'), provider: attribution.optional(), model: attribution.optional(), route: attribution.optional()}),
  z.strictObject({type: z.literal('citation'), citation: answerCitationSchema}),
  z.strictObject({type: z.literal('delta'), text: z.string().max(65536)}),
  z.strictObject({type: z.literal('usage'), usage: z.strictObject({
    inputTokens: tokenCount, outputTokens: tokenCount,
    remainingTokens: tokenCount.optional(), resetAt: z.string().max(160).optional(),
  })}),
  z.strictObject({type: z.literal('completed'), provider: attribution, model: attribution, route: attribution}),
  z.strictObject({type: z.literal('cancelled')}),
  z.strictObject({type: z.literal('failed'), message: z.string().min(1).max(1024), code: z.string().max(80).optional()}),
]);

/** Identifies events that permanently close an answer stream. */
export function isTerminalAnswerEvent(event: AnswerEvent): boolean {
  return event.type === 'completed' || event.type === 'failed' || event.type === 'cancelled';
}

