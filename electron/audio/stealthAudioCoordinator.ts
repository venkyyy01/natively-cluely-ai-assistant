import type { ConfigurableSttLike, SetAudioChannelCount } from './meetingAudioSequencing';

export interface StealthAwareSystemAudioCapture {
  start(): void;
  stop(): void;
  getSampleRate(): number;
  isCapturing?(): boolean;
  refreshSampleRate?(): number;
  waitForReady?(timeoutMs?: number, pollIntervalMs?: number): Promise<number>;
}

export interface StealthAwareMicrophoneCapture {
  start(): void;
  stop(): void;
  getSampleRate(): number;
  isCapturing?(): boolean;
}

export interface StealthAudioPauseSnapshot {
  active: boolean;
  reason: string;
  systemWasCapturing: boolean;
  microphoneWasCapturing: boolean;
}

export interface StealthAudioCoordinatorArgs {
  systemAudioCapture: StealthAwareSystemAudioCapture | null;
  microphoneCapture: StealthAwareMicrophoneCapture | null;
  interviewerStt: ConfigurableSttLike | null;
  userStt: ConfigurableSttLike | null;
  setAudioChannelCount: SetAudioChannelCount;
  beginSystemAudioBuffering?: (reason: string) => void;
  flushBufferedSystemAudio?: (reason: string) => void;
  clearBufferedSystemAudio?: (reason: string) => void;
  defaultSampleRate?: number;
  readyTimeoutMs?: number;
  readyPollIntervalMs?: number;
  onError?: (source: 'system' | 'microphone', error: Error) => void;
}

function resolveDefaultSampleRate(defaultSampleRate?: number): number {
  return defaultSampleRate ?? 48_000;
}

async function resolveSystemRateAfterStart(
  capture: StealthAwareSystemAudioCapture | null,
  fallbackRate: number,
  timeoutMs?: number,
  pollIntervalMs?: number,
): Promise<number> {
  if (!capture) {
    return fallbackRate;
  }

  if (typeof capture.waitForReady === 'function') {
    return capture.waitForReady(timeoutMs, pollIntervalMs);
  }

  return capture.refreshSampleRate?.()
    ?? capture.getSampleRate()
    ?? fallbackRate;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function pauseAudioForStealth(
  args: Pick<
    StealthAudioCoordinatorArgs,
    'systemAudioCapture' | 'microphoneCapture' | 'clearBufferedSystemAudio'
  >,
  reason: string,
): StealthAudioPauseSnapshot {
  const systemWasCapturing = args.systemAudioCapture?.isCapturing?.() ?? false;
  const microphoneWasCapturing = args.microphoneCapture?.isCapturing?.() ?? false;

  args.clearBufferedSystemAudio?.(`stealth pause:${reason}`);

  if (systemWasCapturing) {
    args.systemAudioCapture?.stop();
  }

  if (microphoneWasCapturing) {
    args.microphoneCapture?.stop();
  }

  return {
    active: true,
    reason,
    systemWasCapturing,
    microphoneWasCapturing,
  };
}

export async function resumeAudioAfterStealth(
  args: StealthAudioCoordinatorArgs,
  snapshot: StealthAudioPauseSnapshot | null,
): Promise<void> {
  if (!snapshot?.active) {
    return;
  }

  const fallbackRate = resolveDefaultSampleRate(args.defaultSampleRate);

  if (snapshot.systemWasCapturing && args.systemAudioCapture) {
    args.beginSystemAudioBuffering?.(`stealth resume:${snapshot.reason}`);
    try {
      args.systemAudioCapture.start();
      const systemRate = await resolveSystemRateAfterStart(
        args.systemAudioCapture,
        fallbackRate,
        args.readyTimeoutMs,
        args.readyPollIntervalMs,
      );
      args.interviewerStt?.setSampleRate(systemRate);
      args.setAudioChannelCount(args.interviewerStt, 1);
      args.flushBufferedSystemAudio?.(`stealth resume:${snapshot.reason}`);
    } catch (error) {
      args.clearBufferedSystemAudio?.(`stealth resume failed:${snapshot.reason}`);
      args.onError?.('system', toError(error));
    }
  }

  if (snapshot.microphoneWasCapturing && args.microphoneCapture) {
    try {
      const microphoneRate = args.microphoneCapture.getSampleRate() || fallbackRate;
      args.userStt?.setSampleRate(microphoneRate);
      args.setAudioChannelCount(args.userStt, 1);
      args.microphoneCapture.start();
    } catch (error) {
      args.onError?.('microphone', toError(error));
    }
  }
}
