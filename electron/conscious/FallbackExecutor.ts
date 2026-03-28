// electron/conscious/FallbackExecutor.ts
import { 
  InterviewPhase, 
  FallbackTier, 
  FallbackTierConfig, 
  FALLBACK_TIERS,
  FailureState, 
  DegradationLevel,
  ConsciousResponse 
} from './types';
import { CONSCIOUS_MODE_EMERGENCY_TEMPLATES } from '../llm/prompts';

const FAILURE_THRESHOLDS = {
  reduced: 2,
  minimal: 4,
  emergency: 6,
  recovery: 2,
  cooldownMs: 300000, // 5 minutes
};

export class FallbackExecutor {
  private failureState: FailureState = {
    consecutiveFailures: 0,
    totalFailures: 0,
    lastFailureTime: null,
    lastSuccessTime: null,
    degradationLevel: 'none',
    tierFailures: {
      full_conscious: 0,
      reduced_conscious: 0,
      normal_mode: 0,
      emergency_local: 0,
    },
  };

  getEmergencyResponse(phase: InterviewPhase): string {
    const templates = CONSCIOUS_MODE_EMERGENCY_TEMPLATES[phase];
    if (!templates || templates.length === 0) {
      return "Let me think about that for a moment...";
    }
    return templates[Math.floor(Math.random() * templates.length)];
  }

  recordFailure(tier: FallbackTier): void {
    this.failureState.consecutiveFailures += 1;
    this.failureState.totalFailures += 1;
    this.failureState.lastFailureTime = Date.now();
    this.failureState.tierFailures[tier] += 1;
    this.failureState.degradationLevel = this.calculateDegradationLevel();
  }

  recordSuccess(): void {
    this.failureState.consecutiveFailures = Math.max(
      0, 
      this.failureState.consecutiveFailures - FAILURE_THRESHOLDS.recovery
    );
    this.failureState.lastSuccessTime = Date.now();
    this.failureState.degradationLevel = this.calculateDegradationLevel();
  }

  private calculateDegradationLevel(): DegradationLevel {
    const failures = this.failureState.consecutiveFailures;
    if (failures >= FAILURE_THRESHOLDS.emergency) return 'emergency';
    if (failures >= FAILURE_THRESHOLDS.minimal) return 'minimal';
    if (failures >= FAILURE_THRESHOLDS.reduced) return 'reduced';
    return 'none';
  }

  getFailureState(): FailureState {
    return { ...this.failureState };
  }

  getStartTier(): number {
    switch (this.failureState.degradationLevel) {
      case 'emergency': return 3;
      case 'minimal': return 2;
      case 'reduced': return 1;
      default: return 0;
    }
  }

  getTierConfig(tierIndex: number): FallbackTierConfig {
    return FALLBACK_TIERS[Math.min(tierIndex, FALLBACK_TIERS.length - 1)];
  }

  checkAutoRecovery(): boolean {
    const now = Date.now();
    if (this.failureState.lastFailureTime && 
        now - this.failureState.lastFailureTime > FAILURE_THRESHOLDS.cooldownMs) {
      this.failureState.consecutiveFailures = 0;
      this.failureState.degradationLevel = 'none';
      return true;
    }
    return false;
  }

  async executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      fn()
        .then(result => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  buildEmergencyResponse(phase: InterviewPhase): ConsciousResponse {
    return {
      success: true,
      mode: 'direct',
      openingReasoning: '',
      spokenResponse: this.getEmergencyResponse(phase),
      implementationPlan: [],
      tradeoffs: [],
      edgeCases: [],
      likelyFollowUps: [],
      pushbackResponses: {},
      tier: 3,
      phase,
      threadId: '',
      latencyMs: 0,
      tokensUsed: 0,
    };
  }

  reset(): void {
    this.failureState = {
      consecutiveFailures: 0,
      totalFailures: 0,
      lastFailureTime: null,
      lastSuccessTime: null,
      degradationLevel: 'none',
      tierFailures: {
        full_conscious: 0,
        reduced_conscious: 0,
        normal_mode: 0,
        emergency_local: 0,
      },
    };
  }
}
