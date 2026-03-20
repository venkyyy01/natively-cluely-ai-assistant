import { z, type ZodIssue } from 'zod';
import type { FollowUpMeetingType, FollowUpTone } from '../shared/ipc';

const boundedString = (max: number) => z.string().trim().min(1).max(max);
const optionalBoundedString = (max: number) => z.string().trim().max(max).optional();

export const ipcSchemas = {
  geminiChatArgs: z.tuple([
    boundedString(50000),
    z.array(z.string().trim().min(1).max(4096)).max(8).optional(),
    z.string().max(100000).optional(),
    z.object({ skipSystemPrompt: z.boolean().optional() }).optional(),
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
