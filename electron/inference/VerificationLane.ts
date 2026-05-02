import type { InferenceRequest, LaneResult } from "./types";

interface VerificationLaneOptions {
	getCurrentTranscriptRevision?: () => number;
	verifyDraft?: (
		draft: string,
		request: InferenceRequest,
	) =>
		| Promise<{ accepted: boolean; reason?: string }>
		| { accepted: boolean; reason?: string };
	minDraftLength?: number;
}

export class VerificationLane {
	readonly name = "verification" as const;
	private readonly getCurrentTranscriptRevision: () => number;
	private readonly verifyDraft?: (
		draft: string,
		request: InferenceRequest,
	) =>
		| Promise<{ accepted: boolean; reason?: string }>
		| { accepted: boolean; reason?: string };
	private readonly minDraftLength: number;

	constructor(options: VerificationLaneOptions = {}) {
		this.getCurrentTranscriptRevision =
			options.getCurrentTranscriptRevision ?? (() => Number.NaN);
		this.verifyDraft = options.verifyDraft;
		this.minDraftLength = options.minDraftLength ?? 12;
	}

	getPreferredProviders(): string[] {
		return ["ollama"];
	}

	async execute(request: InferenceRequest): Promise<LaneResult> {
		if (this.isStale(request.transcriptRevision)) {
			return {
				requestId: request.requestId,
				lane: this.name,
				status: "discarded",
				output: null,
				provider: "ollama",
				transcriptRevision: request.transcriptRevision,
				reason: "transcript changed before verification completed",
			};
		}

		const draft = request.draft?.trim() ?? "";
		if (draft.length < this.minDraftLength) {
			return {
				requestId: request.requestId,
				lane: this.name,
				status: "rejected",
				output: null,
				provider: "ollama",
				transcriptRevision: request.transcriptRevision,
				reason: "draft too weak for verification",
			};
		}

		const verdict = this.verifyDraft
			? await this.verifyDraft(draft, request)
			: { accepted: true };
		if (!verdict.accepted) {
			return {
				requestId: request.requestId,
				lane: this.name,
				status: "rejected",
				output: null,
				provider: "ollama",
				transcriptRevision: request.transcriptRevision,
				reason: verdict.reason ?? "verification rejected the draft",
			};
		}

		return {
			requestId: request.requestId,
			lane: this.name,
			status: "completed",
			output: draft,
			provider: "ollama",
			transcriptRevision: request.transcriptRevision,
		};
	}

	private isStale(requestRevision: number): boolean {
		const currentRevision = this.getCurrentTranscriptRevision();
		return (
			Number.isFinite(currentRevision) && currentRevision !== requestRevision
		);
	}
}
