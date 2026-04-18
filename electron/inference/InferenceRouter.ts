import type { RuntimeBudgetScheduler } from '../runtime/RuntimeBudgetScheduler';
import { FastDraftLane } from './FastDraftLane';
import { QualityLane } from './QualityLane';
import { VerificationLane } from './VerificationLane';
import type { InferenceRequest, LaneResult, RouteDecision } from './types';

interface InferenceRouterOptions {
  budgetScheduler?: Pick<RuntimeBudgetScheduler, 'hasHeadroom'>;
  fastDraftLane: FastDraftLane;
  verificationLane: VerificationLane;
  qualityLane: QualityLane;
}

export class InferenceRouter {
  private readonly budgetScheduler?: Pick<RuntimeBudgetScheduler, 'hasHeadroom'>;
  private readonly fastDraftLane: FastDraftLane;
  private readonly verificationLane: VerificationLane;
  private readonly qualityLane: QualityLane;

  constructor(options: InferenceRouterOptions) {
    this.budgetScheduler = options.budgetScheduler;
    this.fastDraftLane = options.fastDraftLane;
    this.verificationLane = options.verificationLane;
    this.qualityLane = options.qualityLane;
  }

  route(request: InferenceRequest): RouteDecision {
    switch (request.requestClass) {
      case 'verify':
        return {
          lane: 'verification',
          schedulerLane: 'semantic',
          providers: this.verificationLane.getPreferredProviders(),
          degraded: false,
          reason: 'explicit verification request',
        };
      case 'quality': {
        const hasQualityBudget = this.budgetScheduler?.hasHeadroom('local-inference') ?? true;
        if (hasQualityBudget) {
          return {
            lane: 'quality',
            schedulerLane: 'local-inference',
            providers: this.qualityLane.getPreferredProviders(),
            degraded: false,
            reason: 'quality budget available',
          };
        }

        return {
          lane: 'fast-draft',
          schedulerLane: 'local-inference',
          providers: this.fastDraftLane.getPreferredProviders(),
          degraded: true,
          reason: 'quality budget unavailable, degrading to fast draft',
        };
      }
      case 'fast':
      default:
        return {
          lane: 'fast-draft',
          schedulerLane: 'local-inference',
          providers: this.fastDraftLane.getPreferredProviders(),
          degraded: false,
          reason: 'fast response requested',
        };
    }
  }

  async run(request: InferenceRequest): Promise<{ decision: RouteDecision; result: LaneResult }> {
    const decision = this.route(request);

    switch (decision.lane) {
      case 'verification':
        return { decision, result: await this.verificationLane.execute(request) };
      case 'quality':
        return { decision, result: await this.qualityLane.execute(request) };
      case 'fast-draft':
      default:
        return { decision, result: await this.fastDraftLane.execute(request) };
    }
  }
}
