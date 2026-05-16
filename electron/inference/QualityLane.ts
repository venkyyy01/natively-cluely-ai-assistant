import type { InferenceRequest, LaneResult } from './types';

interface QualityLaneOptions {
  providers?: string[];
  timeoutMs?: number;
  getCurrentTranscriptRevision?: () => number;
  runProvider: (provider: string, request: InferenceRequest) => Promise<string | null>;
}

export class QualityLane {
  readonly name = 'quality' as const;
  private readonly providers: string[];
  private readonly timeoutMs: number;
  private readonly getCurrentTranscriptRevision: () => number;
  private readonly runProvider: (provider: string, request: InferenceRequest) => Promise<string | null>;

  constructor(options: QualityLaneOptions) {
    this.providers = options.providers ?? ['gemini', 'claude', 'openai'];
    this.timeoutMs = options.timeoutMs ?? 1000;
    this.getCurrentTranscriptRevision = options.getCurrentTranscriptRevision ?? (() => Number.NaN);
    this.runProvider = options.runProvider;
  }

  getPreferredProviders(): string[] {
    return [...this.providers];
  }

  async execute(request: InferenceRequest): Promise<LaneResult> {
    for (const provider of this.providers) {
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), this.timeoutMs);

      try {
        const output = await this.runProvider(provider, request);
        clearTimeout(timeoutId);

        if (!output) {
          continue;
        }

        if (this.isStale(request.transcriptRevision)) {
          return {
            requestId: request.requestId,
            lane: this.name,
            status: 'discarded',
            output: null,
            provider,
            transcriptRevision: request.transcriptRevision,
            reason: 'transcript changed during quality refinement',
          };
        }

        return {
          requestId: request.requestId,
          lane: this.name,
          status: 'completed',
          output,
          provider,
          transcriptRevision: request.transcriptRevision,
        };
      } catch {
        clearTimeout(timeoutId);
        continue;
      }
    }

    return {
      requestId: request.requestId,
      lane: this.name,
      status: 'failed',
      output: null,
      provider: null,
      transcriptRevision: request.transcriptRevision,
      reason: 'quality refinement providers exhausted',
    };
  }

  private isStale(requestRevision: number): boolean {
    const currentRevision = this.getCurrentTranscriptRevision();
    return Number.isFinite(currentRevision) && currentRevision !== requestRevision;
  }
}
