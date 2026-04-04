import { MeetingCheckpointer } from '../MeetingCheckpointer';
import { DatabaseManager } from '../db/DatabaseManager';
import { SessionTracker, MeetingSnapshot, TranscriptSegment, UsageInteraction } from '../SessionTracker';

// Mock the dependencies
jest.mock('../db/DatabaseManager');
jest.mock('../SessionTracker');

describe('MeetingCheckpointer Reliability Tests', () => {
  let checkpointer: MeetingCheckpointer;
  let mockDb: jest.Mocked<DatabaseManager>;
  let mockSessionTracker: jest.Mocked<SessionTracker>;
  let errorEmitSpy: jest.SpyInstance;

  beforeEach(() => {
    mockDb = DatabaseManager.getInstance() as jest.Mocked<DatabaseManager>;
    mockSessionTracker = {
      createSnapshot: jest.fn(),
    } as unknown as jest.Mocked<SessionTracker>;
    
    checkpointer = new MeetingCheckpointer(mockDb, () => mockSessionTracker);
    errorEmitSpy = jest.spyOn(checkpointer, 'emit');
  });

  afterEach(() => {
    checkpointer.stop();
    jest.clearAllMocks();
  });

  const createMockSnapshot = (overrides: Partial<MeetingSnapshot> = {}): MeetingSnapshot => ({
    transcript: [],
    usage: [],
    startTime: Date.now(),
    durationMs: 0,
    context: '',
    meetingMetadata: null,
    ...overrides,
  });

  describe('CRITICAL: Meeting Data Loss Prevention', () => {
    it('should retry checkpoint saves with exponential backoff on DB errors', async () => {
      // ARRANGE: Database fails twice, then succeeds
      const mockSnapshot: MeetingSnapshot = createMockSnapshot({
        transcript: [{ text: 'Important data', speaker: 'User', timestamp: Date.now(), final: true }],
      });
      mockSessionTracker.createSnapshot.mockReturnValue(mockSnapshot);
      
      let callCount = 0;
      mockDb.createOrUpdateMeetingProcessingRecord = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          return Promise.reject(new Error('Database locked'));
        }
        return Promise.resolve();
      });

      // ACT: Start checkpointer and trigger checkpoint
      checkpointer.start('test-meeting-id');
      await (checkpointer as any).checkpoint(); // Force immediate checkpoint via private access for testing

      // ASSERT: Should retry 3 times total (initial + 2 retries)
      expect(mockDb.createOrUpdateMeetingProcessingRecord).toHaveBeenCalledTimes(3);
      expect(errorEmitSpy).not.toHaveBeenCalledWith('checkpoint-failed');
    });

    it('should emit checkpoint-failed event after exhausting retries', async () => {
      // ARRANGE: Database always fails
      const mockSnapshot: MeetingSnapshot = createMockSnapshot();
      mockSessionTracker.createSnapshot.mockReturnValue(mockSnapshot);
      mockDb.createOrUpdateMeetingProcessingRecord = jest.fn().mockRejectedValue(new Error('Disk full'));

      // ACT
      checkpointer.start('test-meeting-id');
      await (checkpointer as any).checkpoint();

      // ASSERT: Should emit failure event after 3 retries
      expect(mockDb.createOrUpdateMeetingProcessingRecord).toHaveBeenCalledTimes(3);
      expect(errorEmitSpy).toHaveBeenCalledWith('checkpoint-failed', expect.objectContaining({
        error: expect.any(Error),
        retryCount: 3
      }));
    });

    it('should fallback to temp file when DB is completely unavailable', async () => {
      // ARRANGE: Database always fails
      const mockSnapshot: MeetingSnapshot = createMockSnapshot({
        transcript: [{ text: 'Critical meeting data', speaker: 'User', timestamp: Date.now(), final: true }],
        meetingMetadata: { title: 'Test Meeting' },
      });
      mockSessionTracker.createSnapshot.mockReturnValue(mockSnapshot);
      mockDb.createOrUpdateMeetingProcessingRecord = jest.fn().mockRejectedValue(new Error('DB connection failed'));

      // ACT
      checkpointer.start('test-meeting-id');
      await (checkpointer as any).checkpoint();

      // ASSERT: Should create temp file backup
      const fs = require('fs').promises;
      const path = require('path');
      const tempDir = path.join(require('os').tmpdir(), 'meeting-checkpoints');
      const tempFiles = await fs.readdir(tempDir);
      const checkpointFiles = tempFiles.filter((f: string) => f.startsWith('meeting-test-meeting-id'));
      
      expect(checkpointFiles.length).toBeGreaterThan(0);
      
      // Verify temp file contains the snapshot data
      const tempFilePath = path.join(tempDir, checkpointFiles[0]);
      const tempFileContent = await fs.readFile(tempFilePath, 'utf8');
      const recoveryData = JSON.parse(tempFileContent);
      
      expect(recoveryData.meetingData.title).toBe('Interim Recording...');
      expect(recoveryData.snapshot.transcript[0].text).toBe('Critical meeting data');

      // Cleanup
      await fs.unlink(tempFilePath);
    });

    it('should handle concurrent checkpoint calls gracefully', async () => {
      // ARRANGE
      const mockSnapshot: MeetingSnapshot = createMockSnapshot();
      mockSessionTracker.createSnapshot.mockReturnValue(mockSnapshot);
      mockDb.createOrUpdateMeetingProcessingRecord = jest.fn().mockImplementation(() => 
        new Promise(resolve => setTimeout(resolve, 100)) // Slow DB
      );

      // ACT: Start multiple concurrent checkpoints
      checkpointer.start('test-meeting-id');
      const promises = [
        (checkpointer as any).checkpoint(),
        (checkpointer as any).checkpoint(),
        (checkpointer as any).checkpoint()
      ];
      await Promise.all(promises);

      // ASSERT: Should serialize checkpoint operations, not run concurrently
      expect(mockDb.createOrUpdateMeetingProcessingRecord).toHaveBeenCalledTimes(1); // Only one actual save
    });
  });

  describe('Resource Management', () => {
    it('should clean up intervals on stop', () => {
      checkpointer.start('test-meeting-id');
      
      // Verify interval is running
      expect((checkpointer as any).interval).toBeTruthy();
      
      checkpointer.stop();
      
      // Verify interval is cleared
      expect((checkpointer as any).interval).toBeNull();
    });

    it('should not prevent process exit with unref interval', () => {
      checkpointer.start('test-meeting-id');
      
      // Verify interval is unref'd
      const interval = (checkpointer as any).interval;
      expect(interval.hasRef()).toBe(false); // Should be unref'd
    });
  });
});
