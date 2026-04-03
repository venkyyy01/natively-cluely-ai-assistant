import { RefObject, useEffect, useRef } from 'react';

type AutoScrollMessage = {
  id: string;
  role: string;
  content: string;
  isStreaming?: boolean;
};

type Options = {
  enabled: boolean;
  containerRef: RefObject<HTMLElement>;
  latestMessage: AutoScrollMessage | null;
  eligibleRoles?: string[];
};

const HUMAN_WORDS_PER_MINUTE = 210;
const MIN_SCROLL_DURATION_MS = 5000;
const MAX_SCROLL_DURATION_MS = 30000;
const MANUAL_PAUSE_MS = 2000;
const RESUME_THRESHOLD_PX = 64;
const PROGRAMMATIC_SCROLL_GRACE_MS = 120;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function estimateDurationMs(content: string): number {
  const words = content.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) {
    return MIN_SCROLL_DURATION_MS;
  }
  return clamp((words / HUMAN_WORDS_PER_MINUTE) * 60_000, MIN_SCROLL_DURATION_MS, MAX_SCROLL_DURATION_MS);
}

function isNearBottom(container: HTMLElement): boolean {
  // With flex-col-reverse, scrollTop=0 is at the visual bottom (newest messages)
  // Check if we're near scrollTop=0 (the top of newest messages)
  return Math.abs(container.scrollTop) <= RESUME_THRESHOLD_PX;
}

export function useHumanSpeedAutoScroll({
  enabled,
  containerRef,
  latestMessage,
  eligibleRoles = ['system', 'assistant'],
}: Options): void {
  const animationFrameRef = useRef<number | null>(null);
  const lastTimestampRef = useRef<number | null>(null);
  const activeMessageIdRef = useRef<string | null>(null);
  const manualPauseUntilRef = useRef<number>(0);
  const followLatestRef = useRef<boolean>(true);
  const programmaticScrollUntilRef = useRef<number>(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const handleScroll = () => {
      if (Date.now() < programmaticScrollUntilRef.current) {
        return;
      }

      if (isNearBottom(container)) {
        manualPauseUntilRef.current = 0;
        followLatestRef.current = true;
        return;
      }

      manualPauseUntilRef.current = Date.now() + MANUAL_PAUSE_MS;
      followLatestRef.current = false;
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      lastTimestampRef.current = null;
    };

    container.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, [containerRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!enabled) {
      activeMessageIdRef.current = null;
      manualPauseUntilRef.current = 0;
      followLatestRef.current = true;
      programmaticScrollUntilRef.current = 0;
      return;
    }

    if (!container || !latestMessage || !eligibleRoles.includes(latestMessage.role)) {
      return;
    }

    const previousMessageId = activeMessageIdRef.current;
    const isNewMessage = previousMessageId !== latestMessage.id;
    const isUserPaused = Date.now() < manualPauseUntilRef.current;
    const userIsNearBottom = isNearBottom(container);

    if (isNewMessage) {
      activeMessageIdRef.current = latestMessage.id;
      lastTimestampRef.current = null;

      const shouldFollowNewMessage =
        previousMessageId === null || userIsNearBottom || (!isUserPaused && followLatestRef.current);

      if (shouldFollowNewMessage) {
        // With flex-col-reverse, newest messages are at scrollTop=0
        programmaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_GRACE_MS;
        container.scrollTo({ top: 0, behavior: 'smooth' });
        manualPauseUntilRef.current = 0;
        followLatestRef.current = true;
      }
    }

    const shouldPauseAutoFollow = (isUserPaused || !followLatestRef.current) && !userIsNearBottom;
    if (shouldPauseAutoFollow) {
      activeMessageIdRef.current = latestMessage.id;
      return;
    }

    if (userIsNearBottom) {
      manualPauseUntilRef.current = 0;
      followLatestRef.current = true;
    }

    const durationMs = estimateDurationMs(latestMessage.content);
    
    const step = (timestamp: number) => {
      if (Date.now() < manualPauseUntilRef.current) {
        animationFrameRef.current = null;
        lastTimestampRef.current = null;
        return;
      }

      if (lastTimestampRef.current === null) {
        lastTimestampRef.current = timestamp;
      }

      // With flex-col-reverse, keep scroll at top (scrollTop=0) for newest messages
      programmaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_GRACE_MS;
      container.scrollTop = 0;

      // Continue animating while message is streaming
      if (latestMessage.isStreaming) {
        animationFrameRef.current = requestAnimationFrame(step);
      } else {
        animationFrameRef.current = null;
        lastTimestampRef.current = null;
      }
    };

    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    animationFrameRef.current = requestAnimationFrame(step);

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      lastTimestampRef.current = null;
    };
  }, [containerRef, enabled, eligibleRoles, latestMessage]);
}
