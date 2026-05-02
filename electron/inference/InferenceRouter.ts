import { getRouteDirector } from "../runtime/RouteDirector";
import type { RuntimeBudgetScheduler } from "../runtime/RuntimeBudgetScheduler";
import { isRouteDirectorEnabled } from "../runtime/routeDirectorEnv";
import type { FastDraftLane } from "./FastDraftLane";
import type { QualityLane } from "./QualityLane";
import type { InferenceRequest, LaneResult, RouteDecision } from "./types";
import type { VerificationLane } from "./VerificationLane";

interface InferenceRouterOptions {
	budgetScheduler?: Pick<RuntimeBudgetScheduler, "hasHeadroom">;
	fastDraftLane: FastDraftLane;
	verificationLane: VerificationLane;
	qualityLane: QualityLane;
}

export class InferenceRouter {
	private readonly budgetScheduler?: Pick<
		RuntimeBudgetScheduler,
		"hasHeadroom"
	>;
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
			case "verify":
				return {
					lane: "verification",
					schedulerLane: "semantic",
					providers: this.verificationLane.getPreferredProviders(),
					degraded: false,
					reason: "explicit verification request",
				};
			case "quality": {
				const hasQualityBudget =
					this.budgetScheduler?.hasHeadroom("local-inference") ?? true;
				if (hasQualityBudget) {
					return {
						lane: "quality",
						schedulerLane: "local-inference",
						providers: this.qualityLane.getPreferredProviders(),
						degraded: false,
						reason: "quality budget available",
					};
				}

				return {
					lane: "fast-draft",
					schedulerLane: "local-inference",
					providers: this.fastDraftLane.getPreferredProviders(),
					degraded: true,
					reason: "quality budget unavailable, degrading to fast draft",
				};
			}
			case "fast":
			default:
				return {
					lane: "fast-draft",
					schedulerLane: "local-inference",
					providers: this.fastDraftLane.getPreferredProviders(),
					degraded: false,
					reason: "fast response requested",
				};
		}
	}

	async run(
		request: InferenceRequest,
	): Promise<{ decision: RouteDecision; result: LaneResult }> {
		const decision = this.route(request);

		if (
			isRouteDirectorEnabled() &&
			request.parallelCandidates === true &&
			request.requestClass === "quality" &&
			decision.lane === "quality" &&
			!decision.degraded
		) {
			const parent = new AbortController();
			const { winnerId, value: result } =
				await getRouteDirector().raceParallelCandidates(
					[
						{
							id: "fast-draft",
							run: (signal) =>
								this.executeLaneWithAbort(this.fastDraftLane, request, signal),
						},
						{
							id: "quality",
							run: (signal) =>
								this.executeLaneWithAbort(this.qualityLane, request, signal),
						},
					],
					{
						parentSignal: parent.signal,
						cancelLoserWithinMs: 500,
						isValid: (r) =>
							r.status === "completed" &&
							r.output != null &&
							r.output.trim().length > 0,
					},
				);

			const finalDecision: RouteDecision =
				winnerId === "quality"
					? decision
					: {
							lane: "fast-draft",
							schedulerLane: decision.schedulerLane,
							providers: this.fastDraftLane.getPreferredProviders(),
							degraded: false,
							reason: "parallel race: fast-draft won",
						};

			return { decision: finalDecision, result };
		}

		switch (decision.lane) {
			case "verification":
				return {
					decision,
					result: await this.verificationLane.execute(request),
				};
			case "quality":
				return { decision, result: await this.qualityLane.execute(request) };
			case "fast-draft":
			default:
				return { decision, result: await this.fastDraftLane.execute(request) };
		}
	}

	private async executeLaneWithAbort(
		lane: FastDraftLane | QualityLane,
		request: InferenceRequest,
		signal: AbortSignal,
	): Promise<LaneResult> {
		if (signal.aborted) {
			return {
				requestId: request.requestId,
				lane: lane.name,
				status: "discarded",
				output: null,
				provider: null,
				transcriptRevision: request.transcriptRevision,
				reason: "aborted before start",
			};
		}

		const execution = lane.execute(request);
		return await new Promise<LaneResult>((resolve, reject) => {
			const onAbort = (): void => {
				resolve({
					requestId: request.requestId,
					lane: lane.name,
					status: "discarded",
					output: null,
					provider: null,
					transcriptRevision: request.transcriptRevision,
					reason: "parallel lane aborted",
				});
			};
			signal.addEventListener("abort", onAbort, { once: true });
			execution
				.then((result) => {
					signal.removeEventListener("abort", onAbort);
					resolve(result);
				})
				.catch((error: unknown) => {
					signal.removeEventListener("abort", onAbort);
					reject(error);
				});
		});
	}
}
