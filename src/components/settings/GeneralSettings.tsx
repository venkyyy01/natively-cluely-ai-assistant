import { Globe, Info, Monitor } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { getOptionalElectronMethod } from "../../lib/electronApi";

type GeneralSettingsProps = {};

export const GeneralSettings: React.FC<GeneralSettingsProps> = () => {
	const getStoredCredentials = getOptionalElectronMethod(
		"getStoredCredentials",
	);
	const getRecognitionLanguages = getOptionalElectronMethod(
		"getRecognitionLanguages",
	);
	const getSttLanguage = getOptionalElectronMethod("getSttLanguage");
	const getAiResponseLanguages = getOptionalElectronMethod(
		"getAiResponseLanguages",
	);
	const getAiResponseLanguage = getOptionalElectronMethod(
		"getAiResponseLanguage",
	);
	const setRecognitionLanguageInMain = getOptionalElectronMethod(
		"setRecognitionLanguage",
	);
	const setAiResponseLanguageInMain = getOptionalElectronMethod(
		"setAiResponseLanguage",
	);
	const selectServiceAccount = getOptionalElectronMethod(
		"selectServiceAccount",
	);
	// Recognition Language
	const [recognitionLanguage, setRecognitionLanguage] = useState("english-us");
	const [availableLanguages, setAvailableLanguages] = useState<
		Record<string, any>
	>({});

	// AI Response Language
	const [aiResponseLanguage, setAiResponseLanguage] = useState("English");
	const [availableAiLanguages, setAvailableAiLanguages] = useState<any[]>([]);

	// Google Service Account
	const [serviceAccountPath, setServiceAccountPath] = useState("");

	useEffect(() => {
		const loadInitialData = async () => {
			// Load Credentials
			try {
				const creds = await getStoredCredentials?.();
				if (creds && creds.googleServiceAccountPath) {
					setServiceAccountPath(creds.googleServiceAccountPath);
				}
			} catch (e) {
				console.error("Failed to load stored credentials:", e);
			}

			// Load STT Languages
			if (getRecognitionLanguages && getSttLanguage) {
				const langs = await getRecognitionLanguages();
				setAvailableLanguages(langs);

				const storedStt = await getSttLanguage();
				setRecognitionLanguage(storedStt || "english-us");
			}

			// Load AI Response Languages
			if (getAiResponseLanguages && getAiResponseLanguage) {
				const aiLangs = await getAiResponseLanguages();
				setAvailableAiLanguages(aiLangs);

				const storedAi = await getAiResponseLanguage();
				setAiResponseLanguage(storedAi || "English");
			}
		};
		loadInitialData();
	}, []);

	const handleLanguageChange = async (key: string) => {
		setRecognitionLanguage(key);
		if (setRecognitionLanguageInMain) {
			await setRecognitionLanguageInMain(key);
		}
	};

	const handleAiLanguageChange = async (key: string) => {
		setAiResponseLanguage(key);
		if (setAiResponseLanguageInMain) {
			await setAiResponseLanguageInMain(key);
		}
	};

	const handleSelectServiceAccount = async () => {
		try {
			const result = await selectServiceAccount?.();
			if (result?.success && result.path) {
				setServiceAccountPath(result.path);
			}
		} catch (error) {
			console.error("Failed to select service account:", error);
		}
	};

	return (
		<div className="space-y-8 animated fadeIn">
			<div>
				<h3 className="text-lg font-bold text-text-primary mb-2">
					General Configuration
				</h3>
				<p className="text-xs text-text-secondary mb-4">
					Core settings for Natively.
				</p>

				<div className="space-y-4">
					{/* Google Cloud Service Account */}
					<div className="bg-bg-item-surface rounded-xl p-5 border border-border-subtle">
						<label className="block text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">
							Google Speech-to-Text Key (JSON)
						</label>
						<div className="flex gap-3">
							<div className="flex-1 bg-bg-input border border-border-subtle rounded-lg px-4 py-2.5 text-xs text-text-secondary truncate flex items-center">
								{serviceAccountPath || "No file selected"}
							</div>
							<button
								onClick={handleSelectServiceAccount}
								className="bg-bg-input hover:bg-bg-secondary border border-border-subtle text-text-primary px-5 py-2.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap"
							>
								Select File
							</button>
						</div>
						<p className="text-xs text-text-tertiary mt-2">
							Required for accurate speech recognition.
						</p>
					</div>

					{/* Recognition Language */}
					<div className="bg-bg-item-surface rounded-xl p-5 border border-border-subtle">
						<label className="block text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">
							Recognition Language (STT)
						</label>
						<div className="relative inline-block">
							<select
								value={recognitionLanguage}
								onChange={(e) => handleLanguageChange(e.target.value)}
								className="appearance-none bg-bg-input border border-border-subtle rounded-lg pl-5 pr-10 py-2.5 text-xs text-text-primary focus:outline-none focus:border-accent-primary transition-colors cursor-pointer"
							>
								{Object.entries(availableLanguages).map(([key, lang]) => (
									<option key={key} value={key}>
										{lang.label}
									</option>
								))}
							</select>
							<Globe
								size={14}
								className="absolute right-3 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none"
							/>
						</div>
						<p className="text-xs text-text-tertiary mt-2">
							The language you and the interviewer are speaking.
						</p>
					</div>

					{/* AI Response Language */}
					<div className="bg-bg-item-surface rounded-xl p-5 border border-border-subtle">
						<label className="block text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">
							AI Response Language
						</label>
						<div className="relative inline-block">
							<select
								value={aiResponseLanguage}
								onChange={(e) => handleAiLanguageChange(e.target.value)}
								className="appearance-none bg-bg-input border border-border-subtle rounded-lg pl-5 pr-10 py-2.5 text-xs text-text-primary focus:outline-none focus:border-accent-primary transition-colors cursor-pointer"
							>
								{availableAiLanguages.map((lang) => (
									<option key={lang.code} value={lang.code}>
										{lang.label}
									</option>
								))}
							</select>
							<Info
								size={14}
								className="absolute right-3 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none"
							/>
						</div>
						<p className="text-xs text-text-tertiary mt-2">
							The language in which the AI will provide its suggestions.
						</p>
					</div>
				</div>
			</div>
		</div>
	);
};
