import { RefObject, useEffect, useRef } from 'react';
import { getAutoFollowDecision } from './humanSpeedAutoScrollState';

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
  // The latest rendered message lives at the top edge of the scroll container.
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
  const isPointerInteractingRef = useRef<boolean>(false);
  const isHoldingManualScrollRef = useRef<boolean>(false);
  const userScrollIntentUntilRef = useRef<number>(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const stopAutoScrollAnimation = () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      lastTimestampRef.current = null;
    };

    const hasManualScrollIntent = () => {
      return isPointerInteractingRef.current || Date.now() < userScrollIntentUntilRef.current;
    };

    const pauseAutoFollow = () => {
      manualPauseUntilRef.current = Date.now() + MANUAL_PAUSE_MS;
      followLatestRef.current = false;
      stopAutoScrollAnimation();
    };

    const markManualScrollIntent = () => {
      userScrollIntentUntilRef.current = Date.now() + 250;
    };

    const handlePointerDown = () => {
      isPointerInteractingRef.current = true;
      isHoldingManualScrollRef.current = false;
      markManualScrollIntent();
    };

    const handleWheel = () => {
      markManualScrollIntent();
      pauseAutoFollow();
    };

    const handleTouchStart = () => {
      markManualScrollIntent();
      pauseAutoFollow();
    };

    const handlePointerRelease = () => {
      if (!isPointerInteractingRef.current) {
        return;
      }

      isPointerInteractingRef.current = false;

      if (!isHoldingManualScrollRef.current) {
        return;
      }

      isHoldingManualScrollRef.current = false;

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
    };

    const handleScroll = () => {
      const userMovedAwayFromLatest = !isNearBottom(container);

      if (userMovedAwayFromLatest) {
        if (hasManualScrollIntent()) {
          isHoldingManualScrollRef.current = true;
        }
        pauseAutoFollow();
        return;
      }

      if (Date.now() < programmaticScrollUntilRef.current) {
        if (!hasManualScrollIntent()) {
          return;
        }
      }

      if (hasManualScrollIntent()) {
        isHoldingManualScrollRef.current = true;
        pauseAutoFollow();
        return;
      }

      if (isNearBottom(container)) {
        manualPauseUntilRef.current = 0;
        followLatestRef.current = true;
        return;
      }

      pauseAutoFollow();
    };

    container.addEventListener('pointerdown', handlePointerDown, { passive: true });
    container.addEventListener('wheel', handleWheel, { passive: true });
    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('pointerup', handlePointerRelease, { passive: true });
    window.addEventListener('pointercancel', handlePointerRelease, { passive: true });

    return () => {
      container.removeEventListener('pointerdown', handlePointerDown);
      container.removeEventListener('wheel', handleWheel);
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('scroll', handleScroll);
      window.removeEventListener('pointerup', handlePointerRelease);
      window.removeEventListener('pointercancel', handlePointerRelease);
    };
  }, [containerRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!enabled) {
      activeMessageIdRef.current = null;
      manualPauseUntilRef.current = 0;
      followLatestRef.current = true;
      programmaticScrollUntilRef.current = 0;
      isPointerInteractingRef.current = false;
      isHoldingManualScrollRef.current = false;
      userScrollIntentUntilRef.current = 0;
      return;
    }

    if (!container || !latestMessage || !eligibleRoles.includes(latestMessage.role)) {
      return;
    }

    const previousMessageId = activeMessageIdRef.current;
    const isNewMessage = previousMessageId !== latestMessage.id;
    const isUserPaused = Date.now() < manualPauseUntilRef.current;
    let userIsNearBottom = isNearBottom(container);
    const userIsHoldingManualScroll = isPointerInteractingRef.current && isHoldingManualScrollRef.current;
    const hasRecentManualScrollIntent =
      isPointerInteractingRef.current || Date.now() < userScrollIntentUntilRef.current;

    const snapToLatest = () => {
      // Auto-follow keeps the newest response pinned at the top edge.
      programmaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_GRACE_MS;
      container.scrollTop = 0;
      manualPauseUntilRef.current = 0;
      followLatestRef.current = true;
      userIsNearBottom = true;
    };

    if (!userIsNearBottom) {
      followLatestRef.current = false;
    }

    if (isNewMessage) {
      activeMessageIdRef.current = latestMessage.id;
      lastTimestampRef.current = null;
    }

    const autoFollowDecision = getAutoFollowDecision({
      hasRecentManualScrollIntent,
      isStreaming: Boolean(latestMessage.isStreaming),
      isUserPaused,
      latestMessageId: latestMessage.id,
      previousMessageId,
      userIsHoldingManualScroll,
      userIsNearBottom,
    });

    if (autoFollowDecision.shouldSnapToLatest) {
      snapToLatest();
    }

    if (autoFollowDecision.shouldPauseAutoFollow) {
      activeMessageIdRef.current = latestMessage.id;
      return;
    }

    if (userIsNearBottom) {
      manualPauseUntilRef.current = 0;
      followLatestRef.current = true;
    }

    const durationMs = estimateDurationMs(latestMessage.content);
    
    const step = (timestamp: number) => {
      if (isPointerInteractingRef.current && isHoldingManualScrollRef.current) {
        animationFrameRef.current = null;
        lastTimestampRef.current = null;
        return;
      }

      if (!isNearBottom(container)) {
        followLatestRef.current = false;
        manualPauseUntilRef.current = Date.now() + MANUAL_PAUSE_MS;
        animationFrameRef.current = null;
        lastTimestampRef.current = null;
        return;
      }

      if (Date.now() < manualPauseUntilRef.current) {
        animationFrameRef.current = null;
        lastTimestampRef.current = null;
        return;
      }

      if (lastTimestampRef.current === null) {
        lastTimestampRef.current = timestamp;
      }

      // Streaming content should stay mounted at the top while it grows.
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
