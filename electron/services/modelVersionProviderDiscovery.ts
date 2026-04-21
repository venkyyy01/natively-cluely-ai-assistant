import {
  ModelFamily,
  TextModelFamily,
  type ModelVersion,
} from './modelVersionTypes';
import {
  parseModelVersion,
  compareVersions,
  classifyModel,
  classifyTextModel,
} from './modelVersionUtils';

export function findLatestInFamily(
  modelIds: string[],
  family: ModelFamily,
  discovered: Map<ModelFamily, { modelId: string; version: ModelVersion }>,
): void {
  let best: { modelId: string; version: ModelVersion } | null = discovered.get(family) || null;

  for (const modelId of modelIds) {
    const classified = classifyModel(modelId);
    if (classified !== family) continue;

    const version = parseModelVersion(modelId);
    if (!version) continue;

    if (!best || compareVersions(version, best.version) > 0) {
      best = { modelId, version };
    }
  }

  if (best) {
    discovered.set(family, best);
  }
}

export function findLatestInTextFamily(
  modelIds: string[],
  family: TextModelFamily,
  discovered: Map<TextModelFamily, { modelId: string; version: ModelVersion }>,
): void {
  let best: { modelId: string; version: ModelVersion } | null = discovered.get(family) || null;

  for (const modelId of modelIds) {
    const classified = classifyTextModel(modelId);
    if (classified !== family) continue;

    const version = parseModelVersion(modelId);
    if (!version) continue;

    if (!best || compareVersions(version, best.version) > 0) {
      best = { modelId, version };
    }
  }

  if (best) {
    discovered.set(family, best);
  }
}

export async function discoverOpenAIModels(
  apiKey: string,
  discovered: Map<ModelFamily, { modelId: string; version: ModelVersion }>,
  textDiscovered: Map<TextModelFamily, { modelId: string; version: ModelVersion }>,
  onSuccess: () => void,
  onFailure: () => void,
): Promise<void> {
  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      onFailure();
      console.warn(`[ModelVersionManager] OpenAI model listing failed: ${response.status}`);
      return;
    }
    const json: any = await response.json();
    const models: string[] = (json.data || []).map((m: any) => m.id);

    findLatestInFamily(models, ModelFamily.OPENAI, discovered);
    findLatestInTextFamily(models, TextModelFamily.OPENAI, textDiscovered);
    onSuccess();
  } catch (err: any) {
    onFailure();
    console.warn(`[ModelVersionManager] OpenAI discovery error: ${err.message}`);
  }
}

export async function discoverGeminiModels(
  apiKey: string,
  discovered: Map<ModelFamily, { modelId: string; version: ModelVersion }>,
  textDiscovered: Map<TextModelFamily, { modelId: string; version: ModelVersion }>,
  onSuccess: () => void,
  onFailure: () => void,
): Promise<void> {
  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + apiKey, {
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      onFailure();
      console.warn(`[ModelVersionManager] Gemini model listing failed: ${response.status}`);
      return;
    }
    const json: any = await response.json();
    const models: string[] = (json.models || []).map((m: any) => (m.name || '').replace(/^models\//, ''));

    findLatestInFamily(models, ModelFamily.GEMINI_FLASH, discovered);
    findLatestInFamily(models, ModelFamily.GEMINI_PRO, discovered);
    findLatestInTextFamily(models, TextModelFamily.GEMINI_FLASH, textDiscovered);
    findLatestInTextFamily(models, TextModelFamily.GEMINI_PRO, textDiscovered);
    onSuccess();
  } catch (err: any) {
    onFailure();
    console.warn(`[ModelVersionManager] Gemini discovery error: ${err.message}`);
  }
}

export async function discoverClaudeModels(
  apiKey: string,
  discovered: Map<ModelFamily, { modelId: string; version: ModelVersion }>,
  textDiscovered: Map<TextModelFamily, { modelId: string; version: ModelVersion }>,
  onSuccess: () => void,
  onFailure: () => void,
): Promise<void> {
  try {
    const allModels: string[] = [];
    let hasMore = true;
    let afterId: string | null = null;

    while (hasMore) {
      const url = afterId
        ? `https://api.anthropic.com/v1/models?limit=100&after_id=${encodeURIComponent(afterId)}`
        : 'https://api.anthropic.com/v1/models?limit=100';

      const response = await fetch(url, {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        onFailure();
        console.warn(`[ModelVersionManager] Anthropic model listing failed: ${response.status}`);
        return;
      }

      const json: any = await response.json();
      const pageModels: string[] = (json.data || []).map((m: any) => m.id);
      allModels.push(...pageModels);

      hasMore = json.has_more === true;
      afterId = json.last_id || null;

      if (allModels.length > 500) {
        console.warn('[ModelVersionManager] Anthropic discovery capped at 500 models');
        break;
      }
    }

    findLatestInFamily(allModels, ModelFamily.CLAUDE, discovered);
    findLatestInTextFamily(allModels, TextModelFamily.CLAUDE, textDiscovered);
    onSuccess();
  } catch (err: any) {
    onFailure();
    console.warn(`[ModelVersionManager] Anthropic discovery error: ${err.message}`);
  }
}

export async function discoverGroqModels(
  apiKey: string,
  discovered: Map<ModelFamily, { modelId: string; version: ModelVersion }>,
  textDiscovered: Map<TextModelFamily, { modelId: string; version: ModelVersion }>,
  onSuccess: () => void,
  onFailure: () => void,
): Promise<void> {
  try {
    const response = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      onFailure();
      console.warn(`[ModelVersionManager] Groq model listing failed: ${response.status}`);
      return;
    }
    const json: any = await response.json();
    const models: string[] = (json.data || []).map((m: any) => m.id);

    findLatestInFamily(models, ModelFamily.GROQ_LLAMA, discovered);
    findLatestInTextFamily(models, TextModelFamily.GROQ, textDiscovered);
    onSuccess();
  } catch (err: any) {
    onFailure();
    console.warn(`[ModelVersionManager] Groq discovery error: ${err.message}`);
  }
}
