import { isOptimizationActive } from "../config/optimizations";
import { ANEEmbeddingProvider } from "./providers/ANEEmbeddingProvider";
import { GeminiEmbeddingProvider } from "./providers/GeminiEmbeddingProvider";
import type { IEmbeddingProvider } from "./providers/IEmbeddingProvider";
import { LocalEmbeddingProvider } from "./providers/LocalEmbeddingProvider";
import { OllamaEmbeddingProvider } from "./providers/OllamaEmbeddingProvider";
import { OpenAIEmbeddingProvider } from "./providers/OpenAIEmbeddingProvider";

export interface AppAPIConfig {
	openaiKey?: string;
	geminiKey?: string;
	ollamaUrl?: string; // e.g. 'http://localhost:11434'
}

export class EmbeddingProviderResolver {
	private static aneProviderAvailable: boolean | null = null;
	private static aneProviderChecked: boolean = false;
	private static aneProvider: ANEEmbeddingProvider | null = null;

	/**
	 * Returns the best available provider.
	 * Runs isAvailable() checks in priority order.
	 * Local model is the unconditional fallback — always last.
	 */
	static async resolve(config: AppAPIConfig): Promise<IEmbeddingProvider> {
		// ANE (Apple Neural Engine) provider - highest priority when acceleration enabled
		if (isOptimizationActive("useANEEmbeddings")) {
			if (!EmbeddingProviderResolver.aneProviderChecked) {
				const aneProvider = new ANEEmbeddingProvider();
				await aneProvider.initialize();
				EmbeddingProviderResolver.aneProviderAvailable =
					await aneProvider.isAvailable();
				EmbeddingProviderResolver.aneProvider =
					EmbeddingProviderResolver.aneProviderAvailable ? aneProvider : null;
				EmbeddingProviderResolver.aneProviderChecked = true;
			}

			if (
				EmbeddingProviderResolver.aneProviderAvailable &&
				EmbeddingProviderResolver.aneProvider
			) {
				console.log(
					`[EmbeddingProviderResolver] ANE provider available, using ${EmbeddingProviderResolver.aneProvider.name} (${EmbeddingProviderResolver.aneProvider.dimensions}d)`,
				);
				return EmbeddingProviderResolver.aneProvider;
			}
			console.log(
				"[EmbeddingProviderResolver] ANE provider unavailable, falling back to other providers",
			);
		}

		const candidates: IEmbeddingProvider[] = [];

		if (config.openaiKey) {
			candidates.push(new OpenAIEmbeddingProvider(config.openaiKey));
		}
		if (config.geminiKey) {
			candidates.push(new GeminiEmbeddingProvider(config.geminiKey));
		}

		candidates.push(
			new OllamaEmbeddingProvider(config.ollamaUrl || "http://localhost:11434"),
		);
		candidates.push(new LocalEmbeddingProvider()); // always last, always works

		for (const provider of candidates) {
			const available = await provider.isAvailable();
			if (available) {
				console.log(
					`[EmbeddingProviderResolver] Selected provider: ${provider.name} (${provider.dimensions}d)`,
				);
				return provider;
			}
			console.log(
				`[EmbeddingProviderResolver] Provider ${provider.name} unavailable, trying next...`,
			);
		}

		// This should never happen since LocalEmbeddingProvider.isAvailable()
		// only returns false if the bundled model is corrupted — a fatal install error
		throw new Error(
			"No embedding provider available. The bundled model may be corrupted. Please reinstall.",
		);
	}
}
