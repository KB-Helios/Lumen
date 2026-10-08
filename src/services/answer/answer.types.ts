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

