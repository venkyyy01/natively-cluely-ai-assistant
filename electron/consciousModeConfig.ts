export interface ConsciousModeRealtimeConfig {
  transcriptDebounceMs: number;
  structuredGenerationTimeoutMs: number;
  resumeTtlMs: number;
  repeatedFailureThreshold: number;
}

export const consciousModeRealtimeConfig: ConsciousModeRealtimeConfig = {
  transcriptDebounceMs: 350,
  structuredGenerationTimeoutMs: 1200,
  resumeTtlMs: 5 * 60 * 1000,
  repeatedFailureThreshold: 3,
};
