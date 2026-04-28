import { LLMHelper } from '../../LLMHelper';
import { createRequestAbortController, LLM_API_TIMEOUT_MS, MAX_OUTPUT_TOKENS } from '../../LLMHelper';
import fs from 'fs';

/**
 * Stream response from OpenAI with proper system/user message separation
 */
export async function* streamWithOpenai(
  helper: LLMHelper,
  userMessage: string,
  systemPrompt?: string,
  abortSignal?: AbortSignal
): AsyncGenerator<string, void, unknown> {
  if (!helper.openaiClient) throw new Error("OpenAI client not initialized");

  const targetModel = helper.getActiveOpenAiModel();

  const messages: any[] = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: userMessage });

  const requestControl = createRequestAbortController(LLM_API_TIMEOUT_MS, abortSignal);
  
  let stream;
  try {
    stream = await helper.openaiClient.chat.completions.create({
      model: targetModel,
      messages,
      stream: true,
      max_completion_tokens: MAX_OUTPUT_TOKENS,
    }, { signal: requestControl.signal });
  } catch (error) {
    if (helper.isModelNotFoundError(error)) {
      const fallbackModel = await helper.resolveOpenAiFallbackModel(targetModel);
      if (fallbackModel && fallbackModel !== targetModel) {
        helper.applyModelFallback({
          provider: 'openai',
          previousModel: targetModel,
          fallbackModel,
          reason: 'model_not_found',
        });
        yield* streamWithOpenaiUsingModel(helper, userMessage, fallbackModel, systemPrompt, abortSignal);
        return;
      }
    }
    requestControl.cleanup();
    throw error;
  }

  try {
    for await (const chunk of stream) {
      if (abortSignal?.aborted) {
        return;
      }
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  } finally {
    requestControl.cleanup();
  }
}

/**
 * Stream multimodal (image + text) response from OpenAI with system/user separation
 */
export async function* streamWithOpenaiMultimodal(
  helper: LLMHelper,
  userMessage: string,
  imagePaths: string[],
  systemPrompt?: string,
  abortSignal?: AbortSignal
): AsyncGenerator<string, void, unknown> {
  if (!helper.openaiClient) throw new Error("OpenAI client not initialized");

  const targetModel = helper.getActiveOpenAiModel();

  const messages: any[] = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  const contentParts: any[] = [{ type: "text", text: userMessage }];
  for (const p of imagePaths) {
    if (fs.existsSync(p)) {
      const imageData = await fs.promises.readFile(p);
      contentParts.push({ type: "image_url", image_url: { url: `data:image/png;base64,${imageData.toString("base64")}` } });
    }
  }
  messages.push({ role: "user", content: contentParts });

  const requestControl = createRequestAbortController(LLM_API_TIMEOUT_MS, abortSignal);
  
  let stream;
  try {
    stream = await helper.openaiClient.chat.completions.create({
      model: targetModel,
      messages,
      stream: true,
      max_completion_tokens: MAX_OUTPUT_TOKENS,
    }, { signal: requestControl.signal });
  } catch (error) {
    if (helper.isModelNotFoundError(error)) {
      const fallbackModel = await helper.resolveOpenAiFallbackModel(targetModel);
      if (fallbackModel && fallbackModel !== targetModel) {
        helper.applyModelFallback({
          provider: 'openai',
          previousModel: targetModel,
          fallbackModel,
          reason: 'model_not_found',
        });
        yield* streamWithOpenaiMultimodalUsingModel(helper, userMessage, imagePaths, fallbackModel, systemPrompt, abortSignal);
        return;
      }
    }
    requestControl.cleanup();
    throw error;
  }

  try {
    for await (const chunk of stream) {
      if (abortSignal?.aborted) {
        return;
      }
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  } finally {
    requestControl.cleanup();
  }
}

export async function* streamWithOpenaiUsingModel(
  helper: LLMHelper,
  userMessage: string,
  model: string,
  systemPrompt?: string,
  abortSignal?: AbortSignal
): AsyncGenerator<string, void, unknown> {
  if (!helper.openaiClient) throw new Error("OpenAI client not initialized");

  const messages: any[] = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: userMessage });

  const requestControl = createRequestAbortController(LLM_API_TIMEOUT_MS, abortSignal);
  const stream = await helper.openaiClient.chat.completions.create({
    model,
    messages,
    stream: true,
    max_completion_tokens: MAX_OUTPUT_TOKENS,
  }, { signal: requestControl.signal });

  try {
    for await (const chunk of stream) {
      if (abortSignal?.aborted) {
        return;
      }
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  } finally {
    requestControl.cleanup();
  }
}

export async function* streamWithOpenaiMultimodalUsingModel(
  helper: LLMHelper,
  userMessage: string,
  imagePaths: string[],
  model: string,
  systemPrompt?: string,
  abortSignal?: AbortSignal
): AsyncGenerator<string, void, unknown> {
  if (!helper.openaiClient) throw new Error("OpenAI client not initialized");

  const messages: any[] = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  const contentParts: any[] = [{ type: "text", text: userMessage }];
  for (const p of imagePaths) {
    if (fs.existsSync(p)) {
      const imageData = await fs.promises.readFile(p);
      contentParts.push({ type: "image_url", image_url: { url: `data:image/png;base64,${imageData.toString("base64")}` } });
    }
  }
  messages.push({ role: "user", content: contentParts });

  const requestControl = createRequestAbortController(LLM_API_TIMEOUT_MS, abortSignal);
  const stream = await helper.openaiClient.chat.completions.create({
    model,
    messages,
    stream: true,
    max_completion_tokens: MAX_OUTPUT_TOKENS,
  }, { signal: requestControl.signal });

  try {
    for await (const chunk of stream) {
      if (abortSignal?.aborted) {
        return;
      }
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  } finally {
    requestControl.cleanup();
  }
}
