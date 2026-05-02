import { dialog } from "electron";
import { ipcSchemas, parseIpcInput } from "../ipcValidation";
import type { AppState } from "../main";
import type { SafeHandle, SafeHandleValidated } from "./registerTypes";

type RegisterProfileHandlersDeps = {
	appState: AppState;
	safeHandle: SafeHandle;
	safeHandleValidated: SafeHandleValidated;
};

type RuntimeCoordinatorLike = {
	getSupervisor?: (name: string) => unknown;
};

type InferenceSupervisorLike = {
	getKnowledgeOrchestrator?: () => unknown;
};

type ProfileIpcSuccess<T> = {
	success: true;
	data: T;
};

type ProfileIpcFailure = {
	success: false;
	error: {
		code: string;
		message: string;
	};
};

function profileSuccess<T>(data: T): ProfileIpcSuccess<T> {
	return {
		success: true,
		data,
	};
}

function profileError(code: string, message: string): ProfileIpcFailure {
	return {
		success: false,
		error: {
			code,
			message,
		},
	};
}

function getKnowledgeOrchestrator(
	appState: AppState,
): ReturnType<AppState["getKnowledgeOrchestrator"]> {
	if (
		"getCoordinator" in appState &&
		typeof appState.getCoordinator === "function"
	) {
		const coordinator = appState.getCoordinator() as RuntimeCoordinatorLike;
		if (typeof coordinator.getSupervisor === "function") {
			const supervisor = coordinator.getSupervisor(
				"inference",
			) as InferenceSupervisorLike;
			if (typeof supervisor?.getKnowledgeOrchestrator === "function") {
				return supervisor.getKnowledgeOrchestrator() as ReturnType<
					AppState["getKnowledgeOrchestrator"]
				>;
			}
		}
	}

	return appState.getKnowledgeOrchestrator();
}

export function registerProfileHandlers({
	appState,
	safeHandle,
	safeHandleValidated,
}: RegisterProfileHandlersDeps): void {
	safeHandleValidated(
		"profile:upload-resume",
		(args) =>
			[
				parseIpcInput(
					ipcSchemas.profileFilePath,
					args[0],
					"profile:upload-resume",
				),
			] as const,
		async (_event, filePath) => {
			try {
				const orchestrator = getKnowledgeOrchestrator(appState);
				if (!orchestrator)
					return profileError(
						"PROFILE_ENGINE_UNAVAILABLE",
						"Knowledge engine not initialized. Please ensure API keys are configured.",
					);
				const { DocType } = require("../../premium/electron/knowledge/types");
				return profileSuccess(
					await orchestrator.ingestDocument(filePath, DocType.RESUME),
				);
			} catch (error: any) {
				return profileError(
					"PROFILE_UPLOAD_FAILED",
					error?.message || "Unable to upload resume",
				);
			}
		},
	);

	safeHandle("profile:get-status", async () => {
		try {
			const orchestrator = getKnowledgeOrchestrator(appState);
			if (!orchestrator)
				return profileSuccess({ hasProfile: false, profileMode: false });
			const status = orchestrator.getStatus();
			return profileSuccess({
				hasProfile: status.hasResume,
				profileMode: status.activeMode,
				name: status.resumeSummary?.name,
				role: status.resumeSummary?.role,
				totalExperienceYears: status.resumeSummary?.totalExperienceYears,
			});
		} catch (error: any) {
			return profileError(
				"PROFILE_STATUS_READ_FAILED",
				error?.message || "Unable to read profile status",
			);
		}
	});

	safeHandleValidated(
		"profile:set-mode",
		(args) =>
			[
				parseIpcInput(ipcSchemas.booleanFlag, args[0], "profile:set-mode"),
			] as const,
		async (_event, enabled) => {
			try {
				const orchestrator = getKnowledgeOrchestrator(appState);
				if (!orchestrator)
					return profileError(
						"PROFILE_ENGINE_UNAVAILABLE",
						"Knowledge engine not initialized",
					);
				orchestrator.setKnowledgeMode(enabled);
				return profileSuccess({ success: true });
			} catch (error: any) {
				return profileError(
					"PROFILE_MODE_UPDATE_FAILED",
					error?.message || "Unable to update profile mode",
				);
			}
		},
	);

	safeHandle("profile:delete", async () => {
		try {
			const orchestrator = getKnowledgeOrchestrator(appState);
			if (!orchestrator)
				return profileError(
					"PROFILE_ENGINE_UNAVAILABLE",
					"Knowledge engine not initialized",
				);
			const { DocType } = require("../../premium/electron/knowledge/types");
			orchestrator.deleteDocumentsByType(DocType.RESUME);
			return profileSuccess({ success: true });
		} catch (error: any) {
			return profileError(
				"PROFILE_DELETE_FAILED",
				error?.message || "Unable to delete resume",
			);
		}
	});

	safeHandle("profile:get-profile", async () => {
		try {
			const orchestrator = getKnowledgeOrchestrator(appState);
			if (!orchestrator) return profileSuccess(null);
			return profileSuccess(orchestrator.getProfileData());
		} catch (error: any) {
			return profileError(
				"PROFILE_READ_FAILED",
				error?.message || "Unable to read profile data",
			);
		}
	});

	safeHandle("profile:select-file", async () => {
		try {
			const result: any = await dialog.showOpenDialog({
				properties: ["openFile"],
				filters: [{ name: "Resume Files", extensions: ["pdf", "docx", "txt"] }],
			});
			if (result.canceled || result.filePaths.length === 0)
				return profileSuccess({ cancelled: true });
			return profileSuccess({ filePath: result.filePaths[0] });
		} catch (error: any) {
			return profileError(
				"PROFILE_FILE_PICKER_FAILED",
				error?.message || "Unable to select profile file",
			);
		}
	});

	safeHandleValidated(
		"profile:upload-jd",
		(args) =>
			[
				parseIpcInput(ipcSchemas.profileFilePath, args[0], "profile:upload-jd"),
			] as const,
		async (_event, filePath) => {
			try {
				const orchestrator = getKnowledgeOrchestrator(appState);
				if (!orchestrator)
					return profileError(
						"PROFILE_ENGINE_UNAVAILABLE",
						"Knowledge engine not initialized. Please ensure API keys are configured.",
					);
				const { DocType } = require("../../premium/electron/knowledge/types");
				return profileSuccess(
					await orchestrator.ingestDocument(filePath, DocType.JD),
				);
			} catch (error: any) {
				return profileError(
					"PROFILE_JD_UPLOAD_FAILED",
					error?.message || "Unable to upload job description",
				);
			}
		},
	);

	safeHandle("profile:delete-jd", async () => {
		try {
			const orchestrator = getKnowledgeOrchestrator(appState);
			if (!orchestrator)
				return profileError(
					"PROFILE_ENGINE_UNAVAILABLE",
					"Knowledge engine not initialized",
				);
			const { DocType } = require("../../premium/electron/knowledge/types");
			orchestrator.deleteDocumentsByType(DocType.JD);
			return profileSuccess({ success: true });
		} catch (error: any) {
			return profileError(
				"PROFILE_JD_DELETE_FAILED",
				error?.message || "Unable to delete job description",
			);
		}
	});

	safeHandleValidated(
		"profile:research-company",
		(args) =>
			[
				parseIpcInput(
					ipcSchemas.profileCompanyName,
					args[0],
					"profile:research-company",
				),
			] as const,
		async (_event, companyName) => {
			try {
				const orchestrator = getKnowledgeOrchestrator(appState);
				if (!orchestrator)
					return profileError(
						"PROFILE_ENGINE_UNAVAILABLE",
						"Knowledge engine not initialized",
					);
				const engine = orchestrator.getCompanyResearchEngine();
				const {
					CredentialsManager,
				} = require("../services/CredentialsManager");
				const cm = CredentialsManager.getInstance();
				const googleSearchKey = cm.getGoogleSearchApiKey();
				const googleSearchCseId = cm.getGoogleSearchCseId();
				if (googleSearchKey && googleSearchCseId) {
					const {
						GoogleCustomSearchProvider,
					} = require("../../premium/electron/knowledge/GoogleCustomSearchProvider");
					engine.setSearchProvider(
						new GoogleCustomSearchProvider(googleSearchKey, googleSearchCseId),
					);
				}
				const profileData = orchestrator.getProfileData();
				const activeJD = profileData?.activeJD;
				const jdCtx = activeJD
					? {
							title: activeJD.title,
							location: activeJD.location,
							level: activeJD.level,
							technologies: activeJD.technologies,
							requirements: activeJD.requirements,
							keywords: activeJD.keywords,
							compensation_hint: activeJD.compensation_hint,
							min_years_experience: activeJD.min_years_experience,
						}
					: {};
				const dossier = await engine.researchCompany(companyName, jdCtx, true);
				return profileSuccess({ success: true, dossier });
			} catch (error: any) {
				return profileError(
					"PROFILE_COMPANY_RESEARCH_FAILED",
					error?.message || "Unable to research company",
				);
			}
		},
	);

	safeHandle("profile:generate-negotiation", async () => {
		try {
			const orchestrator = getKnowledgeOrchestrator(appState);
			if (!orchestrator)
				return profileError(
					"PROFILE_ENGINE_UNAVAILABLE",
					"Knowledge engine not initialized",
				);
			const profileData = orchestrator.getProfileData();
			if (!profileData)
				return profileError("PROFILE_MISSING_RESUME", "No resume uploaded");
			const status = orchestrator.getStatus();
			if (!status.hasResume)
				return profileError("PROFILE_MISSING_RESUME", "No resume loaded");
			let dossier = null;
			if (profileData.activeJD?.company) {
				dossier = orchestrator
					.getCompanyResearchEngine()
					.getCachedDossier(profileData.activeJD.company);
			}
			return profileSuccess({ success: true, dossier, profileData });
		} catch (error: any) {
			return profileError(
				"PROFILE_NEGOTIATION_FAILED",
				error?.message || "Unable to prepare negotiation data",
			);
		}
	});

	safeHandleValidated(
		"set-google-search-api-key",
		(args) =>
			[
				parseIpcInput(ipcSchemas.apiKey, args[0], "set-google-search-api-key"),
			] as const,
		async (_event, apiKey) => {
			try {
				const {
					CredentialsManager,
				} = require("../services/CredentialsManager");
				CredentialsManager.getInstance().setGoogleSearchApiKey(apiKey);
				return profileSuccess({ success: true });
			} catch (error: any) {
				return profileError(
					"PROFILE_SEARCH_CONFIG_FAILED",
					error?.message || "Unable to save Google Search API key",
				);
			}
		},
	);

	safeHandleValidated(
		"set-google-search-cse-id",
		(args) =>
			[
				parseIpcInput(
					ipcSchemas.googleSearchCseId,
					args[0],
					"set-google-search-cse-id",
				),
			] as const,
		async (_event, cseId) => {
			try {
				const {
					CredentialsManager,
				} = require("../services/CredentialsManager");
				CredentialsManager.getInstance().setGoogleSearchCseId(cseId);
				return profileSuccess({ success: true });
			} catch (error: any) {
				return profileError(
					"PROFILE_SEARCH_CONFIG_FAILED",
					error?.message || "Unable to save Google Search CSE ID",
				);
			}
		},
	);
}
