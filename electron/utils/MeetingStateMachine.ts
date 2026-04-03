/**
 * Thread-safe Meeting State Machine
 * 
 * CRITICAL RELIABILITY FIX:
 * Replaces the plain boolean `isMeetingActive` with a proper state machine
 * that provides:
 * - Thread-safe state transitions
 * - Proper state validation
 * - State change notifications
 * - Debugging and logging
 * - Race condition prevention
 */

import { EventEmitter } from 'events';

export enum MeetingState {
  IDLE = 'idle',
  INITIALIZING = 'initializing',
  ACTIVE = 'active',
  PAUSING = 'pausing',
  PAUSED = 'paused',
  RESUMING = 'resuming', 
  STOPPING = 'stopping',
  ERROR = 'error'
}

export interface MeetingStateTransition {
  from: MeetingState;
  to: MeetingState;
  timestamp: number;
  reason?: string;
}

export interface MeetingStateMachineEvents {
  'state-changed': (transition: MeetingStateTransition) => void;
  'state-error': (error: Error, currentState: MeetingState) => void;
}

export class MeetingStateMachine extends EventEmitter {
  private currentState: MeetingState = MeetingState.IDLE;
  private mutex = new (require('./AsyncMutex').AsyncMutex)('MeetingStateMachine', { timeout: 5000 });
  private stateHistory: MeetingStateTransition[] = [];
  private readonly maxHistorySize = 100;

  // Valid state transitions
  private readonly validTransitions: Map<MeetingState, Set<MeetingState>> = new Map();

  private initValidTransitions(): void {
    this.validTransitions.set(MeetingState.IDLE, new Set([MeetingState.INITIALIZING, MeetingState.ERROR]));
    this.validTransitions.set(MeetingState.INITIALIZING, new Set([MeetingState.ACTIVE, MeetingState.ERROR, MeetingState.STOPPING]));
    this.validTransitions.set(MeetingState.ACTIVE, new Set([MeetingState.PAUSING, MeetingState.STOPPING, MeetingState.ERROR]));
    this.validTransitions.set(MeetingState.PAUSING, new Set([MeetingState.PAUSED, MeetingState.ERROR, MeetingState.STOPPING]));
    this.validTransitions.set(MeetingState.PAUSED, new Set([MeetingState.RESUMING, MeetingState.STOPPING, MeetingState.ERROR]));
    this.validTransitions.set(MeetingState.RESUMING, new Set([MeetingState.ACTIVE, MeetingState.ERROR, MeetingState.STOPPING]));
    this.validTransitions.set(MeetingState.STOPPING, new Set([MeetingState.IDLE, MeetingState.ERROR]));
    this.validTransitions.set(MeetingState.ERROR, new Set([MeetingState.STOPPING, MeetingState.IDLE]));
  }

  constructor() {
    super();
    this.initValidTransitions();
    console.log('[MeetingStateMachine] Initialized in IDLE state');
  }

  /**
   * Get current state (thread-safe read)
   */
  public getCurrentState(): MeetingState {
    return this.currentState;
  }

  /**
   * Check if meeting is in an active processing state
   */
  public isMeetingActive(): boolean {
    return this.currentState === MeetingState.ACTIVE || 
           this.currentState === MeetingState.PAUSED;
  }

  /**
   * Check if meeting can process audio/transcription
   */
  public canProcessAudio(): boolean {
    return this.currentState === MeetingState.ACTIVE;
  }

  /**
   * Check if meeting is in a transition state
   */
  public isInTransition(): boolean {
    return [
      MeetingState.INITIALIZING,
      MeetingState.PAUSING,
      MeetingState.RESUMING,
      MeetingState.STOPPING
    ].includes(this.currentState);
  }

  /**
   * Transition to a new state (thread-safe)
   */
  public async transitionTo(
    newState: MeetingState, 
    reason?: string, 
    force: boolean = false
  ): Promise<boolean> {
    return await this.mutex.execute(async () => {
      const oldState = this.currentState;
      
      // Validate transition unless forced
      if (!force && !this.isValidTransition(oldState, newState)) {
        const error = new Error(
          `Invalid state transition: ${oldState} → ${newState}. ` +
          `Valid transitions from ${oldState}: ${Array.from(this.validTransitions.get(oldState) || []).join(', ')}`
        );
        
        console.error('[MeetingStateMachine]', error.message);
        this.emit('state-error', error, oldState);
        return false;
      }

      // Perform transition
      this.currentState = newState;
      const transition: MeetingStateTransition = {
        from: oldState,
        to: newState,
        timestamp: Date.now(),
        reason
      };

      // Update history
      this.stateHistory.push(transition);
      if (this.stateHistory.length > this.maxHistorySize) {
        this.stateHistory.shift();
      }

      // Emit event
      this.emit('state-changed', transition);
      
      console.log(
        `[MeetingStateMachine] State transition: ${oldState} → ${newState}` +
        (reason ? ` (${reason})` : '')
      );

      return true;
    });
  }

  /**
   * Start meeting (IDLE → INITIALIZING → ACTIVE)
   */
  public async startMeeting(reason?: string): Promise<boolean> {
    if (this.currentState !== MeetingState.IDLE) {
      const error = new Error(`Cannot start meeting from state: ${this.currentState}`);
      console.error('[MeetingStateMachine]', error.message);
      this.emit('state-error', error, this.currentState);
      return false;
    }

    // Two-phase start: IDLE → INITIALIZING → ACTIVE
    const initSuccess = await this.transitionTo(MeetingState.INITIALIZING, reason || 'Meeting start requested');
    if (!initSuccess) return false;

    // External code should call completeInitialization() when ready
    return true;
  }

  /**
   * Complete meeting initialization (INITIALIZING → ACTIVE)
   */
  public async completeInitialization(reason?: string): Promise<boolean> {
    return await this.transitionTo(MeetingState.ACTIVE, reason || 'Meeting initialization complete');
  }

  /**
   * Stop meeting (any state → STOPPING → IDLE)
   */
  public async stopMeeting(reason?: string): Promise<boolean> {
    const currentState = this.currentState;
    
    // Can stop from any non-IDLE state
    if (currentState === MeetingState.IDLE) {
      console.log('[MeetingStateMachine] Meeting already idle');
      return true;
    }

    // Two-phase stop: current → STOPPING → IDLE
    const stopSuccess = await this.transitionTo(MeetingState.STOPPING, reason || 'Meeting stop requested');
    if (!stopSuccess) return false;

    // External code should call completeStop() when cleanup is done
    return true;
  }

  /**
   * Complete meeting stop (STOPPING → IDLE)
   */
  public async completeStop(reason?: string): Promise<boolean> {
    return await this.transitionTo(MeetingState.IDLE, reason || 'Meeting stop complete');
  }

  /**
   * Pause meeting (ACTIVE → PAUSING → PAUSED)
   */
  public async pauseMeeting(reason?: string): Promise<boolean> {
    if (this.currentState !== MeetingState.ACTIVE) {
      const error = new Error(`Cannot pause meeting from state: ${this.currentState}`);
      console.error('[MeetingStateMachine]', error.message);
      this.emit('state-error', error, this.currentState);
      return false;
    }

    const pauseSuccess = await this.transitionTo(MeetingState.PAUSING, reason || 'Meeting pause requested');
    if (!pauseSuccess) return false;

    // External code should call completePause() when paused
    return true;
  }

  /**
   * Complete meeting pause (PAUSING → PAUSED)
   */
  public async completePause(reason?: string): Promise<boolean> {
    return await this.transitionTo(MeetingState.PAUSED, reason || 'Meeting pause complete');
  }

  /**
   * Resume meeting (PAUSED → RESUMING → ACTIVE)
   */
  public async resumeMeeting(reason?: string): Promise<boolean> {
    if (this.currentState !== MeetingState.PAUSED) {
      const error = new Error(`Cannot resume meeting from state: ${this.currentState}`);
      console.error('[MeetingStateMachine]', error.message);
      this.emit('state-error', error, this.currentState);
      return false;
    }

    const resumeSuccess = await this.transitionTo(MeetingState.RESUMING, reason || 'Meeting resume requested');
    if (!resumeSuccess) return false;

    // External code should call completeResume() when resumed
    return true;
  }

  /**
   * Complete meeting resume (RESUMING → ACTIVE)
   */
  public async completeResume(reason?: string): Promise<boolean> {
    return await this.transitionTo(MeetingState.ACTIVE, reason || 'Meeting resume complete');
  }

  /**
   * Error state (any state → ERROR)
   */
  public async setErrorState(error: Error, reason?: string): Promise<boolean> {
    const success = await this.transitionTo(
      MeetingState.ERROR, 
      reason || `Error: ${error.message}`,
      true // Force transition
    );
    
    if (success) {
      this.emit('state-error', error, MeetingState.ERROR);
    }
    
    return success;
  }

  /**
   * Recover from error state (ERROR → STOPPING → IDLE)
   */
  public async recoverFromError(reason?: string): Promise<boolean> {
    if (this.currentState !== MeetingState.ERROR) {
      console.warn(`[MeetingStateMachine] Not in error state, cannot recover (current: ${this.currentState})`);
      return false;
    }

    // Go through proper shutdown sequence
    return await this.stopMeeting(reason || 'Recovering from error');
  }

  /**
   * Get state history
   */
  public getStateHistory(): MeetingStateTransition[] {
    return [...this.stateHistory];
  }

  /**
   * Get state statistics
   */
  public getStateStats(): { [state: string]: number } {
    const stats: { [state: string]: number } = {};
    
    for (const transition of this.stateHistory) {
      stats[transition.to] = (stats[transition.to] || 0) + 1;
    }
    
    return stats;
  }

  /**
   * Reset state machine (force back to IDLE)
   */
  public async reset(reason?: string): Promise<void> {
    await this.mutex.execute(async () => {
      const oldState = this.currentState;
      this.currentState = MeetingState.IDLE;
      
      const transition: MeetingStateTransition = {
        from: oldState,
        to: MeetingState.IDLE,
        timestamp: Date.now(),
        reason: reason || 'Force reset'
      };

      this.stateHistory.push(transition);
      this.emit('state-changed', transition);
      
      console.warn(
        `[MeetingStateMachine] FORCE RESET: ${oldState} → ${MeetingState.IDLE}` +
        (reason ? ` (${reason})` : '')
      );
    });
  }

  /**
   * Validate state transition
   */
  private isValidTransition(from: MeetingState, to: MeetingState): boolean {
    const validNextStates = this.validTransitions.get(from);
    return validNextStates ? validNextStates.has(to) : false;
  }

  /**
   * Get debug info
   */
  public getDebugInfo(): object {
    return {
      currentState: this.currentState,
      isMeetingActive: this.isMeetingActive(),
      canProcessAudio: this.canProcessAudio(),
      isInTransition: this.isInTransition(),
      historyLength: this.stateHistory.length,
      lastTransition: this.stateHistory[this.stateHistory.length - 1] || null,
      validTransitions: Array.from(this.validTransitions.get(this.currentState) || [])
    };
  }
}