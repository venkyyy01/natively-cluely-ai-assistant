import type { InferenceRequest, LaneResult } from "./types";

interface FastDraftLaneOptions {
	localProviderName?: string;
	cloudProviderFallbacks?: string[];
	isLocalProviderAvailable?: () => boolean;
	getCurrentTranscriptRevision?: () => number;
	runProvider: (
		provider: string,
		request: InferenceRequest,
	) => Promise<string | null>;
}

export class FastDraftLane {
	readonly name = "fast-draft" as const;
	private readonly localProviderName: string;
	private readonly cloudProviderFallbacks: string[];
	private readonly isLocalProviderAvailable: () => boolean;
	private readonly getCurrentTranscriptRevision: () => number;
	private readonly runProvider: (
		provider: string,
		request: InferenceRequest,
	) => Promise<string | null>;

	constructor(options: FastDraftLaneOptions) {
		this.localProviderName = options.localProviderName ?? "ollama";
		this.cloudProviderFallbacks = options.cloudProviderFallbacks ?? [
			"groq",
			"cerebras",
			"openai",
		];
		this.isLocalProviderAvailable =
			options.isLocalProviderAvailable ?? (() => true);
		this.getCurrentTranscriptRevision =
			options.getCurrentTranscriptRevision ?? (() => Number.NaN);
		this.runProvider = options.runProvider;
	}

	getPreferredProviders(): string[] {
		return this.isLocalProviderAvailable()
			? [this.localProviderName, ...this.cloudProviderFallbacks]
			: [...this.cloudProviderFallbacks];
	}

	async execute(request: InferenceRequest): Promise<LaneResult> {
		for (const provider of this.getPreferredProviders()) {
			try {
				const output = await this.runProvider(provider, request);
				if (!output) {
					continue;
				}

				if (this.isStale(request.transcriptRevision)) {
					return {
						requestId: request.requestId,
						lane: this.name,
						status: "discarded",
						output: null,
						provider,
						transcriptRevision: request.transcriptRevision,
						reason: "transcript changed during fast-draft execution",
					};
				}

				return {
					requestId: request.requestId,
					lane: this.name,
					status: "completed",
					output,
					provider,
					transcriptRevision: request.transcriptRevision,
				};
			} catch {}
		}

		return {
			requestId: request.requestId,
			lane: this.name,
			status: "failed",
			output: null,
			provider: null,
			transcriptRevision: request.transcriptRevision,
			reason: "all fast-draft providers failed",
		};
	}

	private isStale(requestRevision: number): boolean {
		const currentRevision = this.getCurrentTranscriptRevision();
		return (
			Number.isFinite(currentRevision) && currentRevision !== requestRevision
		);
	}
}
