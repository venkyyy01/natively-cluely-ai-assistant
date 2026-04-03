import { MeetingCheckpointer } from '../MeetingCheckpointer';
import { DatabaseManager } from '../db/DatabaseManager';
import { SessionTracker } from '../SessionTracker';

// Mock the dependencies
jest.mock('../db/DatabaseManager');
jest.mock('../SessionTracker');

describe('MeetingCheckpointer Reliability Tests', () => {
  let checkpointer: MeetingCheckpointer;
  let mockDb: jest.Mocked<DatabaseManager>;
  let mockSessionTracker: jest.Mocked<SessionTracker>;
  let errorEmitSpy: jest.SpyInstance;

  beforeEach(() => {
    mockDb = new DatabaseManager(':memory:') as jest.Mocked<DatabaseManager>;
    mockSessionTracker = {
      createSnapshot: jest.fn(),
    } as any;
    
    checkpointer = new MeetingCheckpointer(mockDb, () => mockSessionTracker);
    errorEmitSpy = jest.spyOn(checkpointer, 'emit');
  });

  afterEach(() => {
    checkpointer.stop();
    jest.clearAllMocks();
  });

  describe('CRITICAL: Meeting Data Loss Prevention', () => {
    it('should retry checkpoint saves with exponential backoff on DB errors', async () => {
      // ARRANGE: Database fails twice, then succeeds
      const mockSnapshot = { 
        transcript: [{ text: 'Important data' }], 
        interactions: [], 
        metadata: {} 
      };
      mockSessionTracker.createSnapshot.mockReturnValue(mockSnapshot);
      
      let callCount = 0;
      mockDb.saveMeetingCheckpoint = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          throw new Error('Database locked');
        }
        return Promise.resolve();
      });

      // ACT: Start checkpointer and trigger checkpoint
      checkpointer.start();
      await checkpointer.checkpoint(); // Force immediate checkpoint

      // ASSERT: Should retry 3 times total (initial + 2 retries)
      expect(mockDb.saveMeetingCheckpoint).toHaveBeenCalledTimes(3);
      expect(errorEmitSpy).not.toHaveBeenCalledWith('checkpoint-failed');
    });

    it('should emit checkpoint-failed event after exhausting retries', async () => {
      // ARRANGE: Database always fails
      const mockSnapshot = { transcript: [], interactions: [], metadata: {} };
      mockSessionTracker.createSnapshot.mockReturnValue(mockSnapshot);
      mockDb.saveMeetingCheckpoint = jest.fn().mockRejectedValue(new Error('Disk full'));

      // ACT
      checkpointer.start();
      await checkpointer.checkpoint();

      // ASSERT: Should emit failure event after 3 retries
      expect(mockDb.saveMeetingCheckpoint).toHaveBeenCalledTimes(3);
      expect(errorEmitSpy).toHaveBeenCalledWith('checkpoint-failed', expect.objectContaining({
        error: 'Disk full',
        retryCount: 3
      }));
    });

    it('should fallback to temp file when DB is completely unavailable', async () => {
      // ARRANGE: Database always fails
      const mockSnapshot = { 
        transcript: [{ text: 'Critical meeting data', timestamp: Date.now() }], 
        interactions: [], 
        metadata: { meetingId: 'test-123' } 
      };
      mockSessionTracker.createSnapshot.mockReturnValue(mockSnapshot);
      mockDb.saveMeetingCheckpoint = jest.fn().mockRejectedValue(new Error('DB connection failed'));

      // ACT
      checkpointer.start();
      await checkpointer.checkpoint();

      // ASSERT: Should create temp file backup
      const fs = require('fs').promises;
      const path = require('path');
      const tempDir = require('os').tmpdir();
      const tempFiles = await fs.readdir(tempDir);
      const checkpointFiles = tempFiles.filter((f: string) => f.startsWith('meeting-checkpoint-'));
      
      expect(checkpointFiles.length).toBeGreaterThan(0);
      
      // Verify temp file contains the snapshot data
      const tempFilePath = path.join(tempDir, checkpointFiles[0]);
      const tempFileContent = await fs.readFile(tempFilePath, 'utf8');
      const recoveryData = JSON.parse(tempFileContent);
      
      expect(recoveryData.transcript[0].text).toBe('Critical meeting data');
      expect(recoveryData.metadata.meetingId).toBe('test-123');

      // Cleanup
      await fs.unlink(tempFilePath);
    });

    it('should handle concurrent checkpoint calls gracefully', async () => {
      // ARRANGE
      const mockSnapshot = { transcript: [], interactions: [], metadata: {} };
      mockSessionTracker.createSnapshot.mockReturnValue(mockSnapshot);
      mockDb.saveMeetingCheckpoint = jest.fn().mockImplementation(() => 
        new Promise(resolve => setTimeout(resolve, 100)) // Slow DB
      );

      // ACT: Start multiple concurrent checkpoints
      checkpointer.start();
      const promises = [
        checkpointer.checkpoint(),
        checkpointer.checkpoint(),
        checkpointer.checkpoint()
      ];
      await Promise.all(promises);

      // ASSERT: Should serialize checkpoint operations, not run concurrently
      expect(mockDb.saveMeetingCheckpoint).toHaveBeenCalledTimes(1); // Only one actual save
    });
  });

  describe('Resource Management', () => {
    it('should clean up intervals on stop', () => {
      checkpointer.start();
      
      // Verify interval is running
      expect((checkpointer as any).interval).toBeTruthy();
      
      checkpointer.stop();
      
      // Verify interval is cleared
      expect((checkpointer as any).interval).toBeNull();
    });

    it('should not prevent process exit with unref interval', () => {
      checkpointer.start();
      
      // Verify interval is unref'd
      const interval = (checkpointer as any).interval;
      expect(interval.hasRef()).toBe(false); // Should be unref'd
    });
  });
});