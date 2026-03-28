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
  getTargetElement?: (container: HTMLElement, messageId: string) => HTMLElement | null;
};

const HUMAN_WORDS_PER_MINUTE = 220;
const MIN_SCROLL_DURATION_MS = 8000;
const MAX_SCROLL_DURATION_MS = 45000;
const MANUAL_PAUSE_MS = 12000;

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

export function useHumanSpeedAutoScroll({
  enabled,
  containerRef,
  latestMessage,
  eligibleRoles = ['system', 'assistant'],
  getTargetElement,
}: Options): void {
  const animationFrameRef = useRef<number | null>(null);
  const lastTimestampRef = useRef<number | null>(null);
  const activeMessageIdRef = useRef<string | null>(null);
  const manualPauseUntilRef = useRef<number>(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const pauseAutoScroll = () => {
      manualPauseUntilRef.current = Date.now() + MANUAL_PAUSE_MS;
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };

    container.addEventListener('wheel', pauseAutoScroll, { passive: true });
    container.addEventListener('touchstart', pauseAutoScroll, { passive: true });
    container.addEventListener('pointerdown', pauseAutoScroll);

    return () => {
      container.removeEventListener('wheel', pauseAutoScroll);
      container.removeEventListener('touchstart', pauseAutoScroll);
      container.removeEventListener('pointerdown', pauseAutoScroll);
    };
  }, [containerRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container || !latestMessage || !eligibleRoles.includes(latestMessage.role)) {
      return;
    }

    if (Date.now() < manualPauseUntilRef.current) {
      return;
    }

    if (activeMessageIdRef.current !== latestMessage.id) {
      const targetElement = getTargetElement?.(container, latestMessage.id);
      const targetOffset = targetElement ? Math.max(0, targetElement.offsetTop - container.offsetTop) : 0;
      container.scrollTop = targetOffset;
      activeMessageIdRef.current = latestMessage.id;
    }

    const durationMs = estimateDurationMs(latestMessage.content);
    let speedPxPerMs = 0;
    let targetStart = container.scrollTop;
    const computeSpeed = () => {
      const targetElement = getTargetElement?.(container, latestMessage.id);
      targetStart = targetElement ? Math.max(0, targetElement.offsetTop - container.offsetTop) : targetStart;
      const targetBottom = targetElement ? Math.max(targetStart, targetElement.offsetTop - container.offsetTop + targetElement.scrollHeight - container.clientHeight) : Math.max(0, container.scrollHeight - container.clientHeight);
      speedPxPerMs = Math.max(0, targetBottom - targetStart) / durationMs;
      return targetBottom;
    };

    const step = (timestamp: number) => {
      if (Date.now() < manualPauseUntilRef.current) {
        animationFrameRef.current = null;
        lastTimestampRef.current = null;
        return;
      }

      if (lastTimestampRef.current === null) {
        lastTimestampRef.current = timestamp;
      }

      const dt = timestamp - lastTimestampRef.current;
      lastTimestampRef.current = timestamp;
      const maxScrollTop = computeSpeed();

      if (maxScrollTop <= targetStart) {
        animationFrameRef.current = requestAnimationFrame(step);
        return;
      }

      container.scrollTop = Math.min(maxScrollTop, container.scrollTop + speedPxPerMs * dt);

      if (container.scrollTop < maxScrollTop - 1 || latestMessage.isStreaming) {
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
