export interface OverlayBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

export interface CustomProviderPayload {
  id: string;
  name: string;
  curlCommand: string;
  responsePath: string;
}

export type FollowUpMeetingType = 'interview' | 'call' | 'demo' | 'discussion' | 'meeting';
export type FollowUpTone = 'friendly' | 'neutral' | 'formal';

export interface FollowUpEmailInput {
  meeting_type: FollowUpMeetingType;
  title: string;
  summary?: string;
  action_items?: string[];
  key_points?: string[];
  recipient_name?: string;
  sender_name?: string;
  tone?: FollowUpTone;
}

export interface TranscriptTextEntry {
  text: string;
}

export interface GeminiChatOptions {
  skipSystemPrompt?: boolean;
  requestId?: string;
}

export interface SettingsWindowCoords {
  x?: number;
  y?: number;
}

export type ProviderKind = 'gemini' | 'groq' | 'openai' | 'claude';

export interface MeetingAudioMetadata {
  inputDeviceId?: string | null;
  outputDeviceId?: string | null;
}

export interface StartMeetingMetadata {
  audio?: MeetingAudioMetadata;
}

export interface MeetingSummaryUpdates {
  overview?: string;
  actionItems?: string[];
  keyPoints?: string[];
  actionItemsTitle?: string;
  keyPointsTitle?: string;
}

export interface UpdateMeetingSummaryPayload {
  id: string;
  updates: MeetingSummaryUpdates;
}

export interface UpdateMeetingTitlePayload {
  id: string;
  title: string;
}
