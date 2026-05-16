/**
 * FlexibleResponseRouter
 *
 * The orchestration layer that ties HumanLikeConversationEngine,
 * ConsciousRefinementOrchestrator, and AdaptiveVerificationGate together
 * into a single decision: for THIS turn, what should conscious mode do?
 *
 * Output is a `ConsciousTurnPlan` describing:
 *   - which response shape to produce (structured JSON vs free-form)
 *   - whether refinement should be applied (and what kind)
 *   - what verification rigor is appropriate
 *   - whether the turn should bypass conscious entirely (e.g. pure smalltalk)
 *
 * The router is *advisory*: the conscious feature flag
 * `useHumanLikeConsciousMode` decides whether the orchestrator honours its
 * recommendations. With the flag off, conscious mode behaves exactly as
 * before — every turn is structured + fully verified.
 */

import {
  HumanLikeConversationEngine,
  type ConversationClassification,
  type ConversationKind,
  type RefinementIntent,
  type VerificationLevel,
} from './HumanLikeConversationEngine';
import { AdaptiveVerificationGate, type VerificationPlan } from './AdaptiveVerificationGate';

export type ConsciousResponseShape = 'structured' | 'free_form';

export interface ConsciousTurnPlan {
  conversationKind: ConversationKind;
  classificationConfidence: number;
  responseShape: ConsciousResponseShape;
  verificationLevel: VerificationLevel;
  verification: VerificationPlan;
  refinementIntent?: RefinementIntent;
  /** When true, conscious mode should let standard mode handle this turn. */
  shouldBypassConscious: boolean;
  /** Human-readable explanation, surfaced in latency tracker for debugging. */
  reason: string;
}

export interface FlexibleResponseRouterOptions {
  /** When false, the router always returns the legacy strict plan. */
  enabled: boolean;
}

const STRICT_LEGACY_PLAN: VerificationPlan = {
  runProvenance: true,
  runDeterministic: true,
  runJudge: true,
  reason: 'legacy_strict',
};

export class FlexibleResponseRouter {
  private readonly engine: HumanLikeConversationEngine;
  private readonly gate: AdaptiveVerificationGate;

  constructor(
    engine: HumanLikeConversationEngine = new HumanLikeConversationEngine(),
    gate: AdaptiveVerificationGate = new AdaptiveVerificationGate(),
  ) {
    this.engine = engine;
    this.gate = gate;
  }

  /**
   * Plan a conscious turn for the given user utterance.
   */
  plan(input: {
    utterance: string;
    options: FlexibleResponseRouterOptions;
  }): ConsciousTurnPlan {
    if (!input.options.enabled) {
      return this.buildLegacyPlan('flag_disabled');
    }

    const classification = this.engine.classify(input.utterance);
    return this.planFromClassification(classification);
  }

  /**
   * Convert a precomputed classification into a turn plan. Useful when the
   * caller already classified the utterance for another purpose.
   */
  planFromClassification(classification: ConversationClassification): ConsciousTurnPlan {
    const verification = this.gate.buildPlan(classification.verificationLevel);
    const responseShape: ConsciousResponseShape = classification.preferFreeForm
      ? 'free_form'
      : 'structured';

    // Smalltalk and acknowledgements are *better* answered by standard mode's
    // free-form path. Conscious mode has no value to add — there's no claim
    // to verify, no thread to maintain.
    const shouldBypassConscious =
      classification.kind === 'smalltalk' || classification.kind === 'acknowledgement';

    return {
      conversationKind: classification.kind,
      classificationConfidence: classification.confidence,
      responseShape,
      verificationLevel: classification.verificationLevel,
      verification,
      refinementIntent: classification.refinementIntent,
      shouldBypassConscious,
      reason: `kind=${classification.kind}; ${classification.reason}`,
    };
  }

  /**
   * The legacy plan: run conscious mode the way it always has — structured
   * JSON responses and full verification.
   */
  private buildLegacyPlan(reason: string): ConsciousTurnPlan {
    return {
      conversationKind: 'technical',
      classificationConfidence: 0.5,
      responseShape: 'structured',
      verificationLevel: 'strict',
      verification: STRICT_LEGACY_PLAN,
      shouldBypassConscious: false,
      reason: `legacy_plan:${reason}`,
    };
  }
}
