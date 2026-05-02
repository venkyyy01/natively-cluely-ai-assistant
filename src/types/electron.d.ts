import type {
	CustomProviderPayload,
	FastResponseConfig,
	FollowUpEmailInput,
	GeminiChatOptions,
	OverlayBounds,
	TranscriptTextEntry,
} from "../../shared/ipc";

type StatusResult = { success: boolean; error?: string };
type AnswerRoute =
	| "fast_standard_answer"
	| "enriched_standard_answer"
	| "conscious_answer"
	| "manual_answer"
	| "follow_up_refinement";

type SuggestedAnswerMetadata = {
	route: AnswerRoute;
	attemptedRoute?: AnswerRoute;
	fallbackOccurred: boolean;
	fallbackReason?: string;
	intentConfidence?: number;
	intentProviderUsed?: string;
	intentRetryCount?: number;
	intentFallbackReason?:
		| "primary_unavailable"
		| "primary_retries_exhausted"
		| "primary_failed"
		| "primary_low_confidence"
		| "primary_contradiction";
	prefetchedIntentUsed?: boolean;
	schemaVersion: "standard_answer_v1" | "conscious_mode_v1";
	evidenceHash: string;
	contextSelectionHash?: string;
	transcriptRevision: number;
	threadAction?: "start" | "continue" | "reset" | "ignore";
	thread?: {
		rootQuestion: string;
		lastQuestion: string;
		followUpCount: number;
		updatedAt: number;
	} | null;
	threadState: {
		activeThread: {
			rootQuestion: string;
			lastQuestion: string;
			followUpCount: number;
			updatedAt: number;
		} | null;
		threadAction: "start" | "continue" | "reset" | "ignore";
		transcriptRevision: number;
	};
	cooldownSuppressedMs?: number;
	cooldownReason?: "duplicate_question_debounce";
	verifier?: {
		deterministic: "pass" | "fail" | "skipped";
		judge?: "pass" | "fail" | "skipped";
		provenance: "pass" | "fail" | "skipped";
		reasons?: string[];
	};
	stealthContainmentActive: boolean;
};

type IntelligenceSuggestedAnswerEvent = {
	answer: string;
	question: string;
	confidence: number;
	metadata?: SuggestedAnswerMetadata;
};

export interface ElectronAPI {
	updateContentDimensions: (dimensions: {
		width: number;
		height: number;
	}) => Promise<void>;
	setOverlayBounds: (bounds: OverlayBounds) => Promise<{ success: boolean }>;
	onToggleExpand: (callback: () => void) => () => void;
	getRecognitionLanguages: () => Promise<Record<string, any>>;
	getScreenshots: () => Promise<Array<{ path: string; preview: string }>>;
	deleteScreenshot: (
		path: string,
	) => Promise<{ success: boolean; error?: string }>;
	onScreenshotTaken: (
		callback: (data: { path: string; preview: string }) => void,
	) => () => void;
	onScreenshotAttached: (
		callback: (data: { path: string; preview: string }) => void,
	) => () => void;
	onSolutionsReady: (callback: (solutions: string) => void) => () => void;
	onResetView: (callback: () => void) => () => void;
	onSolutionStart: (callback: () => void) => () => void;
	onDebugStart: (callback: () => void) => () => void;
	onDebugSuccess: (callback: (data: any) => void) => () => void;
	onSolutionError: (callback: (error: string) => void) => () => void;
	onProcessingNoScreenshots: (callback: () => void) => () => void;
	onProblemExtracted: (callback: (data: any) => void) => () => void;
	onSolutionSuccess: (callback: (data: any) => void) => () => void;
	onUnauthorized: (callback: () => void) => () => void;
	onDebugError: (callback: (error: string) => void) => () => void;
	takeScreenshot: () => Promise<{ path: string; preview: string }>;
	takeSelectiveScreenshot: () => Promise<{
		path?: string;
		preview?: string;
		cancelled?: boolean;
	}>;
	moveWindowLeft: () => Promise<void>;
	moveWindowRight: () => Promise<void>;
	moveWindowUp: () => Promise<void>;
	moveWindowDown: () => Promise<void>;

	analyzeImageFile: (path: string) => Promise<unknown>;
	quitApp: () => Promise<void>;
	toggleWindow: () => Promise<void>;
	showWindow: () => Promise<void>;
	hideWindow: () => Promise<void>;
	openExternal: (url: string) => Promise<void>;
	setUndetectable: (state: boolean) => Promise<StatusResult>;
	getUndetectable: () => Promise<boolean>;
	setConsciousMode: (
		enabled: boolean,
	) => Promise<
		| { success: true; data: { enabled: boolean } }
		| { success: false; error: { code: string; message: string } }
	>;
	getConsciousMode: () => Promise<
		| { success: true; data: { enabled: boolean } }
		| { success: false; error: { code: string; message: string } }
	>;
	onConsciousModeChanged: (callback: (enabled: boolean) => void) => () => void;
	setAccelerationMode: (
		enabled: boolean,
	) => Promise<
		| { success: true; data: { enabled: boolean } }
		| { success: false; error: { code: string; message: string } }
	>;
	getAccelerationMode: () => Promise<
		| { success: true; data: { enabled: boolean } }
		| { success: false; error: { code: string; message: string } }
	>;
	onAccelerationModeChanged: (
		callback: (enabled: boolean) => void,
	) => () => void;
	setDisguise: (
		mode: "terminal" | "settings" | "activity" | "none",
	) => Promise<StatusResult>;
	getDisguise: () => Promise<"none" | "terminal" | "settings" | "activity">;
	onDisguiseChanged: (
		callback: (mode: "terminal" | "settings" | "activity" | "none") => void,
	) => () => void;
	setOpenAtLogin: (open: boolean) => Promise<StatusResult>;
	getOpenAtLogin: () => Promise<boolean>;
	onSettingsVisibilityChange: (
		callback: (isVisible: boolean) => void,
	) => () => void;
	toggleSettingsWindow: (coords?: { x: number; y: number }) => Promise<void>;
	closeSettingsWindow: () => Promise<void>;
	toggleAdvancedSettings: () => Promise<void>;
	closeAdvancedSettings: () => Promise<void>;

	// LLM Model Management
	getCurrentLlmConfig: () => Promise<{
		provider: "ollama" | "gemini";
		model: string;
		isOllama: boolean;
	}>;
	getAvailableOllamaModels: () => Promise<string[]>;
	switchToOllama: (
		model?: string,
		url?: string,
	) => Promise<{ success: boolean; error?: string }>;
	switchToGemini: (
		apiKey?: string,
		modelId?: string,
	) => Promise<{ success: boolean; error?: string }>;
	testLlmConnection: (
		provider: "gemini" | "groq" | "openai" | "claude" | "cerebras",
		apiKey?: string,
	) => Promise<{ success: boolean; error?: string }>;
	selectServiceAccount: () => Promise<{
		success: boolean;
		path?: string;
		cancelled?: boolean;
		error?: string;
	}>;

	// API Key Management
	setGeminiApiKey: (
		apiKey: string,
	) => Promise<{ success: boolean; error?: string }>;
	setGroqApiKey: (
		apiKey: string,
	) => Promise<{ success: boolean; error?: string }>;
	setCerebrasApiKey: (
		apiKey: string,
	) => Promise<{ success: boolean; error?: string }>;
	setOpenaiApiKey: (
		apiKey: string,
	) => Promise<{ success: boolean; error?: string }>;
	setClaudeApiKey: (
		apiKey: string,
	) => Promise<{ success: boolean; error?: string }>;
	getStoredCredentials: () => Promise<{
		hasGeminiKey: boolean;
		hasGroqKey: boolean;
		hasCerebrasKey: boolean;
		hasOpenaiKey: boolean;
		hasClaudeKey: boolean;
		googleServiceAccountPath: string | null;
		sttProvider:
			| "google"
			| "groq"
			| "openai"
			| "deepgram"
			| "elevenlabs"
			| "azure"
			| "ibmwatson"
			| "soniox";
		hasSttGroqKey: boolean;
		hasSttOpenaiKey: boolean;
		hasDeepgramKey: boolean;
		hasElevenLabsKey: boolean;
		hasAzureKey: boolean;
		azureRegion: string;
		hasIbmWatsonKey: boolean;
		ibmWatsonRegion: string;
		groqSttModel?: string;
		hasSonioxKey?: boolean;
		hasGoogleSearchKey?: boolean;
		hasGoogleSearchCseId?: boolean;
		geminiPreferredModel?: string;
		groqPreferredModel?: string;
		cerebrasPreferredModel?: string;
		openaiPreferredModel?: string;
		claudePreferredModel?: string;
		fastResponseConfig?: FastResponseConfig;
	}>;

	// STT Provider Management
	setSttProvider: (
		provider:
			| "google"
			| "groq"
			| "openai"
			| "deepgram"
			| "elevenlabs"
			| "azure"
			| "ibmwatson"
			| "soniox",
	) => Promise<{ success: boolean; error?: string }>;
	getSttProvider: () => Promise<string>;
	setGroqSttApiKey: (
		apiKey: string,
	) => Promise<{ success: boolean; error?: string }>;
	setOpenAiSttApiKey: (
		apiKey: string,
	) => Promise<{ success: boolean; error?: string }>;
	setDeepgramApiKey: (
		apiKey: string,
	) => Promise<{ success: boolean; error?: string }>;
	setElevenLabsApiKey: (
		apiKey: string,
	) => Promise<{ success: boolean; error?: string }>;
	setAzureApiKey: (
		apiKey: string,
	) => Promise<{ success: boolean; error?: string }>;
	setAzureRegion: (
		region: string,
	) => Promise<{ success: boolean; error?: string }>;
	setIbmWatsonApiKey: (
		apiKey: string,
	) => Promise<{ success: boolean; error?: string }>;
	setGroqSttModel: (
		model: string,
	) => Promise<{ success: boolean; error?: string }>;
	setSonioxApiKey: (
		apiKey: string,
	) => Promise<{ success: boolean; error?: string }>;
	testSttConnection: (
		provider:
			| "groq"
			| "openai"
			| "deepgram"
			| "elevenlabs"
			| "azure"
			| "ibmwatson"
			| "soniox",
		apiKey: string,
		region?: string,
	) => Promise<{ success: boolean; error?: string }>;

	// Native Audio Service Events
	onNativeAudioTranscript: (
		callback: (transcript: {
			speaker: string;
			text: string;
			final: boolean;
		}) => void,
	) => () => void;
	onNativeAudioSuggestion: (
		callback: (suggestion: {
			context: string;
			lastQuestion: string;
			confidence: number;
		}) => void,
	) => () => void;
	onNativeAudioConnected: (callback: () => void) => () => void;
	onNativeAudioDisconnected: (callback: () => void) => () => void;
	onSuggestionGenerated: (
		callback: (data: {
			question: string;
			suggestion: string;
			confidence: number;
		}) => void,
	) => () => void;
	onSuggestionProcessingStart: (callback: () => void) => () => void;
	onSuggestionError: (
		callback: (error: { error: string }) => void,
	) => () => void;
	onMeetingAudioError: (callback: (message: string) => void) => () => void;
	generateSuggestion: (
		context: string,
		lastQuestion: string,
	) => Promise<{ suggestion: string }>;
	getInputDevices: () => Promise<Array<{ id: string; name: string }>>;
	getOutputDevices: () => Promise<Array<{ id: string; name: string }>>;
	setRecognitionLanguage: (
		key: string,
	) => Promise<{ success: boolean; error?: string }>;
	getAiResponseLanguages: () => Promise<Array<{ label: string; code: string }>>;
	setAiResponseLanguage: (language: string) => Promise<StatusResult>;
	getSttLanguage: () => Promise<string>;
	getAiResponseLanguage: () => Promise<string>;

	getNativeAudioStatus: () => Promise<{ connected: boolean }>;

	// Intelligence Mode IPC
	generateAssist: () => Promise<{ insight: string | null }>;
	generateWhatToSay: (
		question?: string,
		imagePaths?: string[],
	) => Promise<{
		answer: string | null;
		question?: string;
		error?: string;
		status?: "completed" | "canceled" | "error";
	}>;
	generateFollowUp: (
		intent: string,
		userRequest?: string,
	) => Promise<{ refined: string | null; intent: string }>;
	generateFollowUpQuestions: () => Promise<{ questions: string | null }>;
	generateRecap: () => Promise<{ summary: string | null }>;
	submitManualQuestion: (
		question: string,
	) => Promise<{ answer: string | null; question: string }>;
	getIntelligenceContext: () => Promise<{
		context: string;
		lastAssistantMessage: string | null;
		activeMode: string;
	}>;
	resetIntelligence: () => Promise<{ success: boolean; error?: string }>;

	// Meeting Lifecycle
	startMeeting: (
		metadata?: any,
	) => Promise<{ success: boolean; error?: string }>;
	endMeeting: () => Promise<{ success: boolean; error?: string }>;
	finalizeMicSTT: () => Promise<void>;
	getRecentMeetings: () => Promise<
		Array<{
			id: string;
			title: string;
			date: string;
			duration: string;
			summary: string;
			processingState?: "processing" | "completed" | "failed";
		}>
	>;
	getMeetingDetails: (id: string) => Promise<any>;
	updateMeetingTitle: (id: string, title: string) => Promise<boolean>;
	updateMeetingSummary: (
		id: string,
		updates: {
			overview?: string;
			actionItems?: string[];
			keyPoints?: string[];
			actionItemsTitle?: string;
			keyPointsTitle?: string;
		},
	) => Promise<boolean>;
	deleteMeeting: (id: string) => Promise<boolean>;
	setWindowMode: (mode: "launcher" | "overlay") => Promise<void>;
	setOverlayClickthrough: (enabled: boolean) => Promise<void>;
	onOverlayClickthroughChanged: (
		callback: (enabled: boolean) => void,
	) => () => void;
	onGlobalShortcutAction: (callback: (actionId: string) => void) => () => void;

	// Intelligence Mode Events
	onIntelligenceAssistUpdate: (
		callback: (data: { insight: string }) => void,
	) => () => void;
	onIntelligenceCooldown: (
		callback: (data: {
			suppressedMs: number;
			question?: string;
			reason?: "duplicate_question_debounce";
		}) => void,
	) => () => void;
	onIntelligenceSuggestedAnswerToken: (
		callback: (data: {
			token: string;
			question: string;
			confidence: number;
		}) => void,
	) => () => void;
	onIntelligenceSuggestedAnswer: (
		callback: (data: IntelligenceSuggestedAnswerEvent) => void,
	) => () => void;
	onIntelligenceRefinedAnswerToken: (
		callback: (data: { token: string; intent: string }) => void,
	) => () => void;
	onIntelligenceRefinedAnswer: (
		callback: (data: { answer: string; intent: string }) => void,
	) => () => void;
	onIntelligenceFollowUpQuestionsUpdate: (
		callback: (data: { questions: string }) => void,
	) => () => void;
	onIntelligenceFollowUpQuestionsToken: (
		callback: (data: { token: string }) => void,
	) => () => void;
	onIntelligenceRecap: (
		callback: (data: { summary: string }) => void,
	) => () => void;
	onIntelligenceRecapToken: (
		callback: (data: { token: string }) => void,
	) => () => void;
	onIntelligenceManualStarted: (callback: () => void) => () => void;
	onIntelligenceManualResult: (
		callback: (data: { answer: string; question: string }) => void,
	) => () => void;
	onIntelligenceModeChanged: (
		callback: (data: { mode: string }) => void,
	) => () => void;
	onIntelligenceError: (
		callback: (data: { error: string; mode: string }) => void,
	) => () => void;
	// Session Management
	onSessionReset: (callback: () => void) => () => void;
	onMeetingLifecycleState: (
		callback: (state: "idle" | "starting" | "active" | "stopping") => void,
	) => () => void;
	getMeetingLifecycleState: () => Promise<
		"idle" | "starting" | "active" | "stopping"
	>;

	// Streaming listeners
	streamGeminiChat: (
		message: string,
		imagePaths?: string[],
		context?: string,
		options?: GeminiChatOptions,
	) => Promise<void>;
	cancelChat: (requestId: string) => void;
	onGeminiStreamToken: (
		requestId: string,
		callback: (token: string) => void,
	) => () => void;
	onGeminiStreamDone: (requestId: string, callback: () => void) => () => void;
	onGeminiStreamError: (
		requestId: string,
		callback: (error: string) => void,
	) => () => void;

	// Model Management
	getDefaultModel: () => Promise<{ model: string }>;
	setModel: (modelId: string) => Promise<{ success: boolean; error?: string }>;
	setDefaultModel: (
		modelId: string,
	) => Promise<{ success: boolean; error?: string }>;
	toggleModelSelector: (coords: { x: number; y: number }) => Promise<void>;
	forceRestartOllama: () => Promise<void>;

	// Settings Window
	toggleSettingsWindow: (coords?: { x: number; y: number }) => Promise<void>;

	// Fast Response Mode
	getFastResponseConfig: () => Promise<FastResponseConfig>;
	setFastResponseConfig: (
		config: FastResponseConfig,
	) => Promise<{ success: boolean; error?: string }>;

	// Demo
	seedDemo: () => Promise<{ success: boolean }>;

	// Custom Providers
	saveCustomProvider: (
		provider: CustomProviderPayload,
	) => Promise<{ success: boolean; id?: string; error?: string }>;
	getCustomProviders: () => Promise<CustomProviderPayload[]>;
	deleteCustomProvider: (
		id: string,
	) => Promise<{ success: boolean; error?: string }>;

	// Follow-up Email
	generateFollowupEmail: (input: FollowUpEmailInput) => Promise<string>;
	extractEmailsFromTranscript: (
		transcript: TranscriptTextEntry[],
	) => Promise<string[]>;
	getCalendarAttendees: (
		eventId: string,
	) => Promise<Array<{ email: string; name: string }>>;
	openMailto: (params: {
		to: string;
		subject: string;
		body: string;
	}) => Promise<{ success: boolean; error?: string }>;

	// Audio Test
	startAudioTest: (deviceId?: string) => Promise<{ success: boolean }>;
	stopAudioTest: () => Promise<{ success: boolean }>;
	onAudioTestLevel: (callback: (level: number) => void) => () => void;

	// Database
	flushDatabase: () => Promise<{ success: boolean }>;

	onUndetectableChanged: (callback: (state: boolean) => void) => () => void;
	getPrivacyShieldState: () => Promise<{
		active: boolean;
		reason: string | null;
	}>;
	onPrivacyShieldChanged: (
		callback: (state: { active: boolean; reason: string | null }) => void,
	) => () => void;
	onFastResponseConfigChanged: (
		callback: (config: FastResponseConfig) => void,
	) => () => void;
	onModelChanged: (callback: (modelId: string) => void) => () => void;
	onModelFallback: (
		callback: (event: {
			provider: "gemini" | "groq" | "openai" | "claude";
			previousModel: string;
			fallbackModel: string;
			reason: string;
		}) => void,
	) => () => void;

	onOllamaPullProgress: (
		callback: (data: { status: string; percent: number }) => void,
	) => () => void;
	onOllamaPullComplete: (callback: () => void) => () => void;

	onMeetingsUpdated: (callback: () => void) => () => void;

	// Provider Compatibility
	onIncompatibleProviderWarning: (
		callback: (data: {
			count: number;
			oldProvider: string;
			newProvider: string;
		}) => void,
	) => () => void;
	reindexIncompatibleMeetings: () => Promise<void>;

	// Theme API
	getThemeMode: () => Promise<{
		mode: "system" | "light" | "dark";
		resolved: "light" | "dark";
	}>;
	setThemeMode: (mode: "system" | "light" | "dark") => Promise<void>;
	onThemeChanged: (
		callback: (data: {
			mode: "system" | "light" | "dark";
			resolved: "light" | "dark";
		}) => void,
	) => () => void;

	// Calendar
	calendarConnect: () => Promise<{ success: boolean; error?: string }>;
	calendarDisconnect: () => Promise<{ success: boolean; error?: string }>;
	getCalendarStatus: () => Promise<{ connected: boolean; email?: string }>;
	getUpcomingEvents: () => Promise<
		Array<{
			id: string;
			title: string;
			startTime: string;
			endTime: string;
			link?: string;
			source: "google";
		}>
	>;
	calendarRefresh: () => Promise<{ success: boolean; error?: string }>;

	// RAG (Retrieval-Augmented Generation) API
	ragQueryMeeting: (
		meetingId: string,
		query: string,
	) => Promise<{ success?: boolean; fallback?: boolean; error?: string }>;
	ragQueryLive: (
		query: string,
	) => Promise<{ success?: boolean; fallback?: boolean; error?: string }>;
	ragQueryGlobal: (
		query: string,
	) => Promise<{ success?: boolean; fallback?: boolean; error?: string }>;
	ragCancelQuery: (options: {
		meetingId?: string;
		global?: boolean;
		live?: boolean;
	}) => Promise<StatusResult>;
	ragIsMeetingProcessed: (meetingId: string) => Promise<boolean>;
	ragGetQueueStatus: () => Promise<{
		pending: number;
		processing: number;
		completed: number;
		failed: number;
	}>;
	ragRetryEmbeddings: () => Promise<StatusResult>;
	onRAGStreamChunk: (
		callback: (data: {
			meetingId?: string;
			global?: boolean;
			chunk: string;
		}) => void,
	) => () => void;
	onRAGStreamComplete: (
		callback: (data: { meetingId?: string; global?: boolean }) => void,
	) => () => void;
	onRAGStreamError: (
		callback: (data: {
			meetingId?: string;
			global?: boolean;
			error: string;
		}) => void,
	) => () => void;

	// Donation API
	getDonationStatus: () => Promise<{
		shouldShow: boolean;
		hasDonated: boolean;
		lifetimeShows: number;
	}>;
	markDonationToastShown: () => Promise<{ success: boolean }>;
	setDonationComplete: () => Promise<{ success: boolean }>;

	// Keybind Management
	getKeybinds: () => Promise<
		Array<{
			id: string;
			label: string;
			accelerator: string;
			isGlobal: boolean;
			defaultAccelerator: string;
		}>
	>;
	setKeybind: (id: string, accelerator: string) => Promise<boolean>;
	resetKeybinds: () => Promise<
		Array<{
			id: string;
			label: string;
			accelerator: string;
			isGlobal: boolean;
			defaultAccelerator: string;
		}>
	>;
	onKeybindsUpdate: (callback: (keybinds: Array<any>) => void) => () => void;

	// Profile Engine API
	profileUploadResume: (filePath: string) => Promise<StatusResult>;
	profileGetStatus: () => Promise<{
		hasProfile: boolean;
		profileMode: boolean;
		name?: string;
		role?: string;
		totalExperienceYears?: number;
	}>;
	profileSetMode: (enabled: boolean) => Promise<StatusResult>;
	profileDelete: () => Promise<StatusResult>;
	profileGetProfile: () => Promise<any>;
	profileSelectFile: () => Promise<{
		success?: boolean;
		cancelled?: boolean;
		filePath?: string;
		error?: string;
	}>;

	// JD & Research API
	profileUploadJD: (filePath: string) => Promise<StatusResult>;
	profileDeleteJD: () => Promise<StatusResult>;
	profileResearchCompany: (
		companyName: string,
	) => Promise<{ success: boolean; dossier?: any; error?: string }>;
	profileGenerateNegotiation: () => Promise<{
		success: boolean;
		dossier?: any;
		profileData?: any;
		error?: string;
	}>;

	// Google Search API
	setGoogleSearchApiKey: (apiKey: string) => Promise<StatusResult>;
	setGoogleSearchCseId: (cseId: string) => Promise<StatusResult>;

	// Dynamic Model Discovery
	fetchProviderModels: (
		provider: "gemini" | "groq" | "openai" | "claude" | "cerebras",
		apiKey: string,
	) => Promise<{
		success: boolean;
		models?: { id: string; label: string }[];
		error?: string;
	}>;
	setProviderPreferredModel: (
		provider: "gemini" | "groq" | "openai" | "claude" | "cerebras",
		modelId: string,
	) => Promise<void>;

	// License Management
	licenseActivate: (
		key: string,
	) => Promise<{ success: boolean; error?: string }>;
	licenseCheckPremium: () => Promise<boolean>;
	licenseDeactivate: () => Promise<void>;
	licenseGetHardwareId: () => Promise<string>;

	// Overlay Opacity (Stealth Mode)
	setOverlayOpacity: (opacity: number) => Promise<void>;
	onOverlayOpacityChanged: (callback: (opacity: number) => void) => () => void;

	// Diagnostics
	logErrorToMain: (
		payload: any,
	) => Promise<{ success: boolean; error?: string }>;
}

declare global {
	interface Window {
		electronAPI: ElectronAPI;
	}
}
