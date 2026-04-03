export type AutoFollowDecision = {
  shouldPauseAutoFollow: boolean;
  shouldSnapToLatest: boolean;
};

type AutoFollowDecisionInput = {
  hasRecentManualScrollIntent: boolean;
  isStreaming: boolean;
  isUserPaused: boolean;
  latestMessageId: string;
  previousMessageId: string | null;
  userIsHoldingManualScroll: boolean;
  userIsNearBottom: boolean;
};

export function getAutoFollowDecision({
  hasRecentManualScrollIntent,
  isStreaming,
  isUserPaused,
  latestMessageId,
  previousMessageId,
  userIsHoldingManualScroll,
  userIsNearBottom,
}: AutoFollowDecisionInput): AutoFollowDecision {
  const isNewMessage = previousMessageId !== latestMessageId;
  const canResumeAutoFollow =
    !isUserPaused && !hasRecentManualScrollIntent && !userIsHoldingManualScroll;

  const shouldFollowNewMessage =
    isNewMessage && (previousMessageId === null || userIsNearBottom || canResumeAutoFollow);
  const shouldResumeStreaming =
    !isNewMessage && isStreaming && !userIsNearBottom && canResumeAutoFollow;
  const shouldSnapToLatest = shouldFollowNewMessage || shouldResumeStreaming;
  const isNearBottomAfterDecision = userIsNearBottom || shouldSnapToLatest;
  const shouldPauseAutoFollow =
    userIsHoldingManualScroll || (isUserPaused && !isNearBottomAfterDecision);

  return {
    shouldPauseAutoFollow,
    shouldSnapToLatest,
  };
}
