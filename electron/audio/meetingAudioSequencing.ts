export interface SampleRateCaptureLike {
  getSampleRate(): number;
}

export interface RefreshableSystemAudioCaptureLike extends SampleRateCaptureLike {
  start(): void;
  refreshSampleRate?(): number;
  waitForReady?(timeoutMs?: number, pollIntervalMs?: number): Promise<number>;
}

export interface StartableMicrophoneCaptureLike extends SampleRateCaptureLike {
  start(): void;
}

export interface ConfigurableSttLike {
  setSampleRate(rate: number): void;
  start?(): void;
}

export type SetAudioChannelCount = (stt: ConfigurableSttLike | null, count: number) => void;

export interface ConfigureMeetingAudioPipelineArgs {
  systemAudioCapture: SampleRateCaptureLike | null;
  microphoneCapture: SampleRateCaptureLike | null;
  interviewerStt: ConfigurableSttLike | null;
  userStt: ConfigurableSttLike | null;
  setAudioChannelCount: SetAudioChannelCount;
  defaultSampleRate?: number;
}

export interface StartMeetingAudioStreamsArgs extends ConfigureMeetingAudioPipelineArgs {
  systemAudioCapture: RefreshableSystemAudioCaptureLike | null;
  microphoneCapture: StartableMicrophoneCaptureLike | null;
  beforeSystemAudioStart?: () => void;
  afterInterviewerSttReady?: () => void;
  readyTimeoutMs?: number;
  readyPollIntervalMs?: number;
}

export interface RestartMeetingAudioStreamsArgs {
  systemAudioCapture: RefreshableSystemAudioCaptureLike | null;
  microphoneCapture: StartableMicrophoneCaptureLike | null;
  reconnectInterviewerStt: (systemRate: number) => Promise<void>;
  reconnectUserStt: () => Promise<void>;
  beforeSystemAudioStart?: () => void;
  afterInterviewerSttReady?: () => void;
  defaultSampleRate?: number;
  readyTimeoutMs?: number;
  readyPollIntervalMs?: number;
}

function resolveDefaultSampleRate(defaultSampleRate?: number): number {
  return defaultSampleRate ?? 48_000;
}

async function resolveSystemRateAfterStart(
  systemAudioCapture: RefreshableSystemAudioCaptureLike | null,
  fallbackRate: number,
  readyTimeoutMs?: number,
  readyPollIntervalMs?: number,
): Promise<number> {
  if (!systemAudioCapture) {
    return fallbackRate;
  }

  if (typeof systemAudioCapture.waitForReady === 'function') {
    return systemAudioCapture.waitForReady(readyTimeoutMs, readyPollIntervalMs);
  }

  return systemAudioCapture.refreshSampleRate?.()
    ?? systemAudioCapture.getSampleRate()
    ?? fallbackRate;
}

export function configureMeetingAudioPipeline({
  systemAudioCapture,
  microphoneCapture,
  interviewerStt,
  userStt,
  setAudioChannelCount,
  defaultSampleRate,
}: ConfigureMeetingAudioPipelineArgs): { systemRate: number; microphoneRate: number } {
  const fallbackRate = resolveDefaultSampleRate(defaultSampleRate);
  const systemRate = systemAudioCapture?.getSampleRate() || fallbackRate;
  const microphoneRate = microphoneCapture?.getSampleRate() || fallbackRate;

  interviewerStt?.setSampleRate(systemRate);
  setAudioChannelCount(interviewerStt, 1);

  userStt?.setSampleRate(microphoneRate);
  setAudioChannelCount(userStt, 1);

  return { systemRate, microphoneRate };
}

export async function startMeetingAudioStreams({
  systemAudioCapture,
  microphoneCapture,
  interviewerStt,
  userStt,
  setAudioChannelCount,
  defaultSampleRate,
  beforeSystemAudioStart,
  afterInterviewerSttReady,
  readyTimeoutMs,
  readyPollIntervalMs,
}: StartMeetingAudioStreamsArgs): Promise<{ systemRate: number; microphoneRate: number }> {
  const fallbackRate = resolveDefaultSampleRate(defaultSampleRate);

  beforeSystemAudioStart?.();
  systemAudioCapture?.start();

  const systemRate = await resolveSystemRateAfterStart(
    systemAudioCapture,
    fallbackRate,
    readyTimeoutMs,
    readyPollIntervalMs,
  );

  interviewerStt?.setSampleRate(systemRate);
  setAudioChannelCount(interviewerStt, 1);

  const microphoneRate = microphoneCapture?.getSampleRate() || fallbackRate;
  userStt?.setSampleRate(microphoneRate);
  setAudioChannelCount(userStt, 1);

  interviewerStt?.start?.();
  afterInterviewerSttReady?.();
  userStt?.start?.();
  microphoneCapture?.start();

  return { systemRate, microphoneRate };
}

export async function restartMeetingAudioStreamsAfterReconfigure({
  systemAudioCapture,
  microphoneCapture,
  reconnectInterviewerStt,
  reconnectUserStt,
  beforeSystemAudioStart,
  afterInterviewerSttReady,
  defaultSampleRate,
  readyTimeoutMs,
  readyPollIntervalMs,
}: RestartMeetingAudioStreamsArgs): Promise<void> {
  const fallbackRate = resolveDefaultSampleRate(defaultSampleRate);
  beforeSystemAudioStart?.();
  systemAudioCapture?.start();

  const systemRate = await resolveSystemRateAfterStart(
    systemAudioCapture,
    fallbackRate,
    readyTimeoutMs,
    readyPollIntervalMs,
  );

  await reconnectInterviewerStt(systemRate);
  afterInterviewerSttReady?.();
  await reconnectUserStt();
  microphoneCapture?.start();
}
