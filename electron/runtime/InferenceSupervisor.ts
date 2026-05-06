import type { InferenceRouter } from "../inference/InferenceRouter";
import type {
	InferenceRequest,
	LaneResult,
	RouteDecision,
} from "../inference/types";
import { SupervisorBus } from "./SupervisorBus";
import type { ISupervisor, SupervisorState } from "./types";

export interface InferenceSupervisorDelegate {
	start?: () => Promise<void> | void;
	stop?: () => Promise<void> | void;
	onStealthFault?: (reason: string) => Promise<void> | void;
	onDraftReady?: (requestId: string) => Promise<void> | void;
	onAnswerCommitted?: (requestId: string) => Promise<void> | void;
	getLLMHelper?: () => unknown;
	runAssistMode?: () => Promise<string | null> | string | null;
	runWhatShouldISay?: (
		question?: string,
		confidence?: number,
		imagePaths?: string[],
	) => Promise<string | null> | string | null;
	runFollowUp?: (
		intent: string,
		userRequest?: string,
	) => Promise<string | null> | string | null;
	runRecap?: () => Promise<string | null> | string | null;
	runFollowUpQuestions?: () =>
		| Promise<string[] | string | null>
		| string[]
		| string
		| null;
	runManualAnswer?: (
		question: string,
	) => Promise<string | null> | string | null;
	getFormattedContext?: (lastSeconds?: number) => string;
	getLastAssistantMessage?: () => string | null;
	getActiveMode?: () => unknown;
	reset?: () => Promise<void> | void;
	getRAGManager?: () => unknown;
	getKnowledgeOrchestrator?: () => unknown;
	getIntelligenceManager?: () => unknown;
	initializeLLMs?: () => Promise<void> | void;
	onBudgetPressure?: (
		lane: string,
		level: "warning" | "critical",
	) => Promise<void> | void;
}

interface InferenceSupervisorOptions {
	delegate: InferenceSupervisorDelegate;
	bus?: SupervisorBus;
	router?: InferenceRouter;
}

export class InferenceSupervisor implements ISupervisor {
	readonly name = "inference" as const;
	private state: SupervisorState = "idle";
	private readonly delegate: InferenceSupervisorDelegate;
	private readonly bus: SupervisorBus;
	private readonly router?: InferenceRouter;
	private speculationEnabled = true;

	constructor(options: InferenceSupervisorOptions) {
		this.delegate = options.delegate;
		this.bus = options.bus ?? new SupervisorBus();
		this.router = options.router;
		this.bus.subscribe("stealth:fault", async (event) => {
			await this.handleStealthFault(event.reason);
		});
		this.bus.subscribe("budget:pressure", async (event) => {
			await this.handleBudgetPressure(event.lane, event.level);
		});
	}

	getState(): SupervisorState {
		return this.state;
	}

	async start(): Promise<void> {
		if (this.state !== "idle") {
			throw new Error(`Cannot start inference supervisor while ${this.state}`);
		}

		this.state = "starting";
		try {
			await this.delegate.start?.();
			this.state = "running";
		} catch (error) {
			this.state = "faulted";
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (this.state === "idle") {
			return;
		}

		this.state = "stopping";
		try {
			await this.delegate.stop?.();
		} finally {
			this.state = "idle";
		}
	}

	private async handleStealthFault(reason: string): Promise<void> {
		if (this.state !== "running") {
			return;
		}

		await this.delegate.onStealthFault?.(reason);
	}

	async publishDraftReady(requestId: string): Promise<void> {
		await this.delegate.onDraftReady?.(requestId);
		await this.bus.emit({ type: "inference:draft-ready", requestId });
	}

	async commitAnswer(requestId: string): Promise<void> {
		await this.delegate.onAnswerCommitted?.(requestId);
		await this.bus.emit({ type: "inference:answer-committed", requestId });
	}

	getLLMHelper<T = unknown>(): T {
		if (!this.delegate.getLLMHelper) {
			throw new Error(
				"Inference supervisor delegate does not expose an LLM helper",
			);
		}

		return this.delegate.getLLMHelper() as T;
	}

	async runAssistMode(): Promise<string | null> {
		if (!this.delegate.runAssistMode) {
			throw new Error(
				"Inference supervisor delegate does not expose assist mode",
			);
		}

		return await this.delegate.runAssistMode();
	}

	async runWhatShouldISay(
		question?: string,
		confidence?: number,
		imagePaths?: string[],
	): Promise<string | null> {
		if (!this.delegate.runWhatShouldISay) {
			throw new Error(
				"Inference supervisor delegate does not expose what-to-say mode",
			);
		}

		return await this.delegate.runWhatShouldISay(
			question,
			confidence,
			imagePaths,
		);
	}

	async runFollowUp(
		intent: string,
		userRequest?: string,
	): Promise<string | null> {
		if (!this.delegate.runFollowUp) {
			throw new Error(
				"Inference supervisor delegate does not expose follow-up mode",
			);
		}

		return await this.delegate.runFollowUp(intent, userRequest);
	}

	async runRecap(): Promise<string | null> {
		if (!this.delegate.runRecap) {
			throw new Error(
				"Inference supervisor delegate does not expose recap mode",
			);
		}

		return await this.delegate.runRecap();
	}

	async runFollowUpQuestions(): Promise<string[] | string | null> {
		if (!this.delegate.runFollowUpQuestions) {
			throw new Error(
				"Inference supervisor delegate does not expose follow-up questions mode",
			);
		}

		return await this.delegate.runFollowUpQuestions();
	}

	async runManualAnswer(question: string): Promise<string | null> {
		if (!this.delegate.runManualAnswer) {
			throw new Error(
				"Inference supervisor delegate does not expose manual answer mode",
			);
		}

		return await this.delegate.runManualAnswer(question);
	}

	getFormattedContext(lastSeconds?: number): string {
		if (!this.delegate.getFormattedContext) {
			throw new Error(
				"Inference supervisor delegate does not expose formatted context",
			);
		}

		return this.delegate.getFormattedContext(lastSeconds);
	}

	getLastAssistantMessage(): string | null {
		if (!this.delegate.getLastAssistantMessage) {
			throw new Error(
				"Inference supervisor delegate does not expose the last assistant message",
			);
		}

		return this.delegate.getLastAssistantMessage();
	}

	getActiveMode<T = unknown>(): T {
		if (!this.delegate.getActiveMode) {
			throw new Error(
				"Inference supervisor delegate does not expose the active mode",
			);
		}

		return this.delegate.getActiveMode() as T;
	}

	async reset(): Promise<void> {
		if (!this.delegate.reset) {
			throw new Error("Inference supervisor delegate does not expose reset");
		}

		await this.delegate.reset();
	}

	getRAGManager<T = unknown>(): T {
		if (!this.delegate.getRAGManager) {
			throw new Error(
				"Inference supervisor delegate does not expose a RAG manager",
			);
		}

		return this.delegate.getRAGManager() as T;
	}

	getKnowledgeOrchestrator<T = unknown>(): T {
		if (!this.delegate.getKnowledgeOrchestrator) {
			throw new Error(
				"Inference supervisor delegate does not expose a knowledge orchestrator",
			);
		}

		return this.delegate.getKnowledgeOrchestrator() as T;
	}

	getIntelligenceManager<T = unknown>(): T {
		if (!this.delegate.getIntelligenceManager) {
			throw new Error(
				"Inference supervisor delegate does not expose an intelligence manager",
			);
		}

		return this.delegate.getIntelligenceManager() as T;
	}

	async initializeLLMs(): Promise<void> {
		if (!this.delegate.initializeLLMs) {
			throw new Error(
				"Inference supervisor delegate does not expose initializeLLMs",
			);
		}

		await this.delegate.initializeLLMs();
	}

	isSpeculationAllowed(): boolean {
		return this.speculationEnabled;
	}

	async submit(
		request: InferenceRequest,
	): Promise<{ decision: RouteDecision; result: LaneResult }> {
		if (!this.router) {
			throw new Error(
				"Inference supervisor does not expose an inference router",
			);
		}

		const response = await this.router.run(request);
		if (
			response.result.status === "completed" &&
			response.result.lane === "fast-draft"
		) {
			await this.publishDraftReady(request.requestId);
		}
		if (
			response.result.status === "completed" &&
			response.result.lane === "quality"
		) {
			await this.commitAnswer(request.requestId);
		}

		return response;
	}

	private async handleBudgetPressure(
		lane: string,
		level: "warning" | "critical",
	): Promise<void> {
		if (lane === "background" && level === "critical") {
			this.speculationEnabled = false;
		}
		if (level === "warning" && lane === "background") {
			this.speculationEnabled = false;
		}

		await this.delegate.onBudgetPressure?.(lane, level);
	}
}
