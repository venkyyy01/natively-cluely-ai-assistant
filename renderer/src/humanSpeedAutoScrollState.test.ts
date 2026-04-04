import { getAutoFollowDecision } from '../../src/hooks/humanSpeedAutoScrollState';

test('resumes auto-follow for the next assistant message after the manual pause expires', () => {
  expect(
    getAutoFollowDecision({
      hasRecentManualScrollIntent: false,
      isStreaming: false,
      isUserPaused: false,
      latestMessageId: 'message-2',
      previousMessageId: 'message-1',
      userIsHoldingManualScroll: false,
      userIsNearBottom: false,
    }),
  ).toEqual({
    shouldPauseAutoFollow: false,
    shouldSnapToLatest: true,
  });
});

test('resumes auto-follow for streaming updates after the manual pause expires', () => {
  expect(
    getAutoFollowDecision({
      hasRecentManualScrollIntent: false,
      isStreaming: true,
      isUserPaused: false,
      latestMessageId: 'message-1',
      previousMessageId: 'message-1',
      userIsHoldingManualScroll: false,
      userIsNearBottom: false,
    }),
  ).toEqual({
    shouldPauseAutoFollow: false,
    shouldSnapToLatest: true,
  });
});

test('keeps auto-follow paused while the manual pause timer is still active', () => {
  expect(
    getAutoFollowDecision({
      hasRecentManualScrollIntent: false,
      isStreaming: true,
      isUserPaused: true,
      latestMessageId: 'message-1',
      previousMessageId: 'message-1',
      userIsHoldingManualScroll: false,
      userIsNearBottom: false,
    }),
  ).toEqual({
    shouldPauseAutoFollow: true,
    shouldSnapToLatest: false,
  });
});
