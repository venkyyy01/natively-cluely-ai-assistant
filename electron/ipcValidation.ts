import { z, type ZodIssue } from 'zod';
import type { FollowUpMeetingType, FollowUpTone, ProviderKind } from '../shared/ipc';

const boundedString = (max: number) => z.string().trim().min(1).max(max);
const optionalBoundedString = (max: number) => z.string().trim().max(max).optional();
const sttProviderEnum = z.enum(['google', 'groq', 'openai', 'deepgram', 'elevenlabs', 'azure', 'ibmwatson', 'soniox']);
const llmProviderEnum = z.enum(['gemini', 'groq', 'openai', 'claude']);

export const ipcSchemas = {
  geminiChatArgs: z.tuple([
    boundedString(50000),
    z.array(z.string().trim().min(1).max(4096)).max(8).optional(),
    z.string().max(100000).optional(),
    z.object({
      skipSystemPrompt: z.boolean().optional(),
      requestId: boundedString(128).optional(),
    }).optional(),
  ]),
  customProvider: z.object({
    id: boundedString(128),
    name: boundedString(120),
    curlCommand: boundedString(20000),
    responsePath: boundedString(512),
  }).strict(),
  followUpEmailInput: z.object({
    meeting_type: z.enum(['interview', 'call', 'demo', 'discussion', 'meeting'] as [FollowUpMeetingType, ...FollowUpMeetingType[]]),
    title: boundedString(300),
    summary: optionalBoundedString(12000),
    action_items: z.array(boundedString(500)).max(100).optional(),
    key_points: z.array(boundedString(500)).max(100).optional(),
    recipient_name: optionalBoundedString(120),
    sender_name: optionalBoundedString(120),
    tone: z.enum(['friendly', 'neutral', 'formal'] as [FollowUpTone, ...FollowUpTone[]]).optional(),
  }).strict(),
  transcriptEntries: z.array(z.object({ text: boundedString(10000) }).strict()).max(2000),
  settingsWindowCoords: z.object({
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
  }).strict(),
  providerPreferredModel: z.tuple([
    z.enum(['gemini', 'groq', 'openai', 'claude'] as [ProviderKind, ...ProviderKind[]]),
    boundedString(256),
  ]),
  recognitionLanguage: boundedString(64),
  aiResponseLanguage: boundedString(64),
  disguiseMode: z.enum(['terminal', 'settings', 'activity', 'none']),
  startMeetingMetadata: z.object({
    audio: z.object({
      inputDeviceId: z.string().trim().max(256).nullable().optional(),
      outputDeviceId: z.string().trim().max(256).nullable().optional(),
    }).strict().optional(),
  }).strict().optional(),
  updateMeetingSummaryPayload: z.object({
    id: boundedString(128),
    updates: z.object({
      overview: z.string().max(20000).optional(),
      actionItems: z.array(z.string().trim().max(500)).max(100).optional(),
      keyPoints: z.array(z.string().trim().max(500)).max(100).optional(),
      actionItemsTitle: z.string().trim().max(120).optional(),
      keyPointsTitle: z.string().trim().max(120).optional(),
    }).strict(),
  }).strict(),
  updateMeetingTitlePayload: z.object({
    id: boundedString(128),
    title: boundedString(300),
  }).strict(),
  rendererLogPayload: z.object({
    message: z.string().max(20000).optional(),
    stack: z.string().max(50000).optional(),
    context: z.string().max(2000).optional(),
    metadata: z.record(z.unknown()).optional(),
  }).passthrough(),
  generateSuggestionArgs: z.tuple([
    boundedString(100000),
    boundedString(10000),
  ]),
  contentDimensions: z.object({
    width: z.number().finite().positive().max(4000),
    height: z.number().finite().positive().max(4000),
  }).strict(),
  windowMode: z.enum(['launcher', 'overlay']),
  absoluteUserDataPath: z.string().trim().min(1).max(2000),
  modelSelectorCoords: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
  }).strict(),
  modelId: boundedString(256),
  sttProvider: sttProviderEnum,
  apiKey: boundedString(4096),
  optionalApiKey: z.string().trim().max(4096).optional(),
  azureRegion: boundedString(128),
  sttConnectionArgs: z.tuple([sttProviderEnum.exclude(['google']), z.string().trim().max(4096), z.string().trim().max(128).optional()]),
  llmConnectionArgs: z.tuple([llmProviderEnum, z.string().trim().max(4096).optional()]),
  providerModelFetchArgs: z.tuple([llmProviderEnum, z.string().trim().max(4096)]),
  providerSwitchGeminiArgs: z.tuple([z.string().trim().max(4096).optional(), z.string().trim().max(256).optional()]),
  ollamaSwitchArgs: z.tuple([z.string().trim().max(256).optional(), z.string().trim().max(2048).optional()]),
  providerId: boundedString(128),
  booleanFlag: z.boolean(),
  overlayOpacity: z.number().finite(),
  profileFilePath: boundedString(2000),
  profileCompanyName: boundedString(256),
  googleSearchCseId: boundedString(256),
  ragMeetingQuery: z.object({
    meetingId: boundedString(128),
    query: boundedString(10000),
    requestId: boundedString(128).optional(),
  }).strict(),
  ragLiveQuery: z.object({
    query: boundedString(10000),
    requestId: boundedString(128).optional(),
  }).strict(),
  ragGlobalQuery: z.object({
    query: boundedString(10000),
    requestId: boundedString(128).optional(),
  }).strict(),
  ragCancelQuery: z.object({
    meetingId: boundedString(128).optional(),
    global: z.boolean().optional(),
  }).strict().refine((value) => value.global === true || typeof value.meetingId === 'string', {
    message: 'meetingId or global is required',
  }),
  themeMode: z.enum(['system', 'light', 'dark']),
  openMailtoInput: z.object({
    to: z.string().trim().max(2000),
    subject: z.string().max(500),
    body: z.string().max(20000),
  }).strict(),
};

export function parseIpcInput<T>(schema: z.ZodType<T>, payload: unknown, channel: string): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issues = result.error.issues.map((issue: ZodIssue) => `${issue.path.join('.') || 'root'}: ${issue.message}`).join('; ');
    throw new Error(`Invalid IPC payload for ${channel}: ${issues}`);
  }

  return result.data;
}
