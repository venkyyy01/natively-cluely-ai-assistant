// electron/llm/types.ts
// Shared types for the Natively LLM system

import { GoogleGenAI } from "@google/genai";

/**
 * Generation configuration for Gemini calls
 */
export interface GenerationConfig {
    maxOutputTokens: number;
    temperature: number;
    topP: number;
}

/**
 * Mode-specific token limits
 */
export const MODE_CONFIGS = {
    answer: {
        maxOutputTokens: 65536,
        temperature: 0.25,
        topP: 0.85,
    } as GenerationConfig,

    assist: {
        maxOutputTokens: 65536,
        temperature: 0.25,
        topP: 0.85,
    } as GenerationConfig,

    followUp: {
        maxOutputTokens: 65536,
        temperature: 0.25,
        topP: 0.85,
    } as GenerationConfig,

    recap: {
        maxOutputTokens: 65536,
        temperature: 0.25,
        topP: 0.85,
    } as GenerationConfig,

    followUpQuestions: {
        maxOutputTokens: 65536,
        temperature: 0.4, // Slightly higher creative freedom
        topP: 0.9,
    } as GenerationConfig,
} as const;

/**
 * Gemini content structure
 */
export interface GeminiContent {
    role: "user" | "model";
    parts: { text: string }[];
}

/**
 * LLM client interface for dependency injection
 */
export interface LLMClient {
    getGeminiClient(): GoogleGenAI | null;
}

/**
 * Response quality validation result
 */
export interface ValidationResult {
  isValid: boolean;
  violations: string[];
  regenerationHint?: string;
  metrics: {
    sentenceCount: number;
    maxWordsPerSentence: number;
    estimatedSpeakingTime: number;
  };
}

/**
 * Response quality analysis
 */
export interface ResponseQuality {
  followsPyramid: boolean;
  hasAiSpeak: string[];
  isWithinLimits: boolean;
}
