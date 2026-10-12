export function sampleFrameCadence(options?: {sampleCount?: number; signal?: AbortSignal}): Promise<{
  intervals: number[];
  medianMs: number | null;
  p95Ms: number | null;
}>;
