import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncMutex } from '../utils/AsyncMutex';

describe('Meeting Start Race Condition Tests', () => {
  let mockMainInstance: any;
  
  beforeEach(() => {
    mockMainInstance = {
      isMeetingActive: false,
      meetingStartMutex: Promise.resolve(),
      startMeeting: () => {},
      sessionTracker: {
        startNewSession: () => {}
      },
      databaseManager: {
        createMeeting: () => {}
      }
    };
  });

  describe('CRITICAL: Meeting Start Race Condition', () => {
    it('concurrent meeting starts should be serialized', async () => {
      const mutex = new AsyncMutex();
      let meetingStartCount = 0;
      let concurrentExecutions = 0;
      let maxConcurrent = 0;

      const startMeetingOperation = async () => {
        const release = await mutex.acquire();
        try {
          concurrentExecutions++;
          maxConcurrent = Math.max(maxConcurrent, concurrentExecutions);
          
          await new Promise(resolve => setTimeout(resolve, 50));
          meetingStartCount++;
          
          concurrentExecutions--;
        } finally {
          release();
        }
      };

      const promises = [
        startMeetingOperation(),
        startMeetingOperation(),
        startMeetingOperation()
      ];

      await Promise.all(promises);

      assert.equal(maxConcurrent, 1);
      assert.equal(meetingStartCount, 3); // All 3 complete, just serialized
    });

    it('current implementation allows race condition', async () => {
      let activeOperations = 0;
      let maxConcurrent = 0;

      const fakeStartMeeting = async () => {
        if (!mockMainInstance.isMeetingActive) {
          activeOperations++;
          maxConcurrent = Math.max(maxConcurrent, activeOperations);
          
          await new Promise(resolve => setTimeout(resolve, 50));
          
          mockMainInstance.isMeetingActive = true;
          activeOperations--;
        }
      };

      await Promise.all([
        fakeStartMeeting(),
        fakeStartMeeting(),
        fakeStartMeeting()
      ]);

      assert.ok(maxConcurrent > 1);
    });
  });

  describe('Meeting State Synchronization', () => {
    it('boolean isMeetingActive has race conditions', async () => {
      let readCount = 0;
      let writeCount = 0;
      const results: boolean[] = [];

      const reader = async () => {
        for (let i = 0; i < 100; i++) {
          results.push(mockMainInstance.isMeetingActive);
          readCount++;
          await new Promise(resolve => setTimeout(resolve, 1));
        }
      };

      const writer = async () => {
        for (let i = 0; i < 100; i++) {
          mockMainInstance.isMeetingActive = i % 2 === 0;
          writeCount++;
          await new Promise(resolve => setTimeout(resolve, 1));
        }
      };

      await Promise.all([reader(), writer()]);

      assert.equal(readCount, 100);
      assert.equal(writeCount, 100);
    });
  });

  describe('Required: AsyncMutex Implementation', () => {
    it('AsyncMutex should serialize async operations', async () => {
      const mutex = new AsyncMutex();
      let currentlyExecuting = 0;
      let maxConcurrent = 0;
      const executionOrder: number[] = [];

      const operation = async (id: number) => {
        const release = await mutex.acquire();
        try {
          currentlyExecuting++;
          maxConcurrent = Math.max(maxConcurrent, currentlyExecuting);
          executionOrder.push(id);
          
          await new Promise(resolve => setTimeout(resolve, 10));
          
          currentlyExecuting--;
        } finally {
          release();
        }
      };

      await Promise.all([1, 2, 3, 4, 5].map(operation));

      assert.equal(maxConcurrent, 1);
      assert.equal(executionOrder.length, 5);
    });

    it('AsyncMutex should handle errors gracefully', async () => {
      const mutex = new AsyncMutex();
      let operationsCompleted = 0;

      const operation = async (shouldThrow: boolean) => {
        const release = await mutex.acquire();
        try {
          if (shouldThrow) {
            throw new Error('Operation failed');
          }
          operationsCompleted++;
        } finally {
          release();
        }
      };

      const results = await Promise.allSettled([
        operation(false),
        operation(true),
        operation(false),
        operation(true),
        operation(false)
      ]);

      assert.equal(operationsCompleted, 3);
      assert.equal(results.filter(r => r.status === 'rejected').length, 2);
    });
  });
});
