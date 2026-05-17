import Database from 'better-sqlite3';
import path from 'path';
import { app } from 'electron';

export interface VerificationLogEntry {
  id?: number;
  profileId: string;
  timestamp: number;
  response: string;
  grounding: string;
  verdict: 'pass' | 'fail';
  reason?: string;
  verifierType: 'deterministic' | 'provenance' | 'judge' | 'bayesian';
}

const MAX_RECORDS_PER_PROFILE = 10000;
const DB_NAME = 'verification_logs.db';

export class VerificationLogger {
  private db: Database.Database | null = null;
  private inMemoryFallback = false;
  private inMemoryLogs: VerificationLogEntry[] = [];

  constructor(private profileId: string) {
    this.initializeDatabase();
  }

  private initializeDatabase(): void {
    try {
      const userDataPath = app.getPath('userData');
      const dbPath = path.join(userDataPath, DB_NAME);
      
      this.db = new Database(dbPath);
      this.db.pragma('journal_mode = WAL');
      
      // Create table if not exists
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS verification_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profileId TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          response TEXT NOT NULL,
          grounding TEXT NOT NULL,
          verdict TEXT NOT NULL,
          reason TEXT,
          verifierType TEXT NOT NULL
        );
        
        CREATE INDEX IF NOT EXISTS idx_profile_timestamp 
        ON verification_logs(profileId, timestamp);
      `);

      console.log('[VerificationLogger] Database initialized at', dbPath);
    } catch (error) {
      console.warn('[VerificationLogger] Database initialization failed, falling back to in-memory logging:', error);
      this.inMemoryFallback = true;
    }
  }

  /**
   * Log a verification result
   */
  log(entry: Omit<VerificationLogEntry, 'id' | 'profileId'>): void {
    const fullEntry: VerificationLogEntry = {
      ...entry,
      profileId: this.profileId,
    };

    if (this.inMemoryFallback || !this.db) {
      this.inMemoryLogs.push(fullEntry);
      // Prune in-memory logs if too large
      if (this.inMemoryLogs.length > 1000) {
        this.inMemoryLogs = this.inMemoryLogs.slice(-1000);
      }
      return;
    }

    try {
      const stmt = this.db.prepare(`
        INSERT INTO verification_logs 
        (profileId, timestamp, response, grounding, verdict, reason, verifierType)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        fullEntry.profileId,
        fullEntry.timestamp,
        fullEntry.response,
        fullEntry.grounding,
        fullEntry.verdict,
        fullEntry.reason || null,
        fullEntry.verifierType
      );

      // Prune old records if exceeding limit
      this.pruneOldRecords();
    } catch (error) {
      console.warn('[VerificationLogger] Failed to log entry, falling back to in-memory:', error);
      this.inMemoryLogs.push(fullEntry);
    }
  }

  /**
   * Retrieve logs for this profile
   */
  getLogs(limit: number = 100): VerificationLogEntry[] {
    if (this.inMemoryFallback || !this.db) {
      return this.inMemoryLogs.slice(-limit);
    }

    try {
      const stmt = this.db.prepare(`
        SELECT * FROM verification_logs 
        WHERE profileId = ? 
        ORDER BY timestamp DESC 
        LIMIT ?
      `);
      return stmt.all(this.profileId, limit) as VerificationLogEntry[];
    } catch (error) {
      console.warn('[VerificationLogger] Failed to retrieve logs, returning in-memory fallback:', error);
      return this.inMemoryLogs.slice(-limit);
    }
  }

  /**
   * Get failure logs for analysis
   */
  getFailureLogs(limit: number = 100): VerificationLogEntry[] {
    if (this.inMemoryFallback || !this.db) {
      return this.inMemoryLogs.filter(l => l.verdict === 'fail').slice(-limit);
    }

    try {
      const stmt = this.db.prepare(`
        SELECT * FROM verification_logs 
        WHERE profileId = ? AND verdict = 'fail'
        ORDER BY timestamp DESC 
        LIMIT ?
      `);
      return stmt.all(this.profileId, limit) as VerificationLogEntry[];
    } catch (error) {
      console.warn('[VerificationLogger] Failed to retrieve failure logs:', error);
      return this.inMemoryLogs.filter(l => l.verdict === 'fail').slice(-limit);
    }
  }

  /**
   * Get statistics about verification outcomes
   */
  getStats(): { total: number; pass: number; fail: number; passRate: number } {
    const logs = this.getLogs(MAX_RECORDS_PER_PROFILE);
    const total = logs.length;
    const pass = logs.filter(l => l.verdict === 'pass').length;
    const fail = logs.filter(l => l.verdict === 'fail').length;
    const passRate = total > 0 ? pass / total : 0;

    return { total, pass, fail, passRate };
  }

  /**
   * Prune old records to stay within limit
   */
  private pruneOldRecords(): void {
    if (!this.db) return;

    try {
      const countStmt = this.db.prepare(`
        SELECT COUNT(*) as count FROM verification_logs WHERE profileId = ?
      `);
      const result = countStmt.get(this.profileId) as { count: number };

      if (result.count > MAX_RECORDS_PER_PROFILE) {
        const deleteStmt = this.db.prepare(`
          DELETE FROM verification_logs 
          WHERE id IN (
            SELECT id FROM verification_logs 
            WHERE profileId = ? 
            ORDER BY timestamp ASC 
            LIMIT ?
          )
        `);
        const toDelete = result.count - MAX_RECORDS_PER_PROFILE;
        deleteStmt.run(this.profileId, toDelete);
        console.log(`[VerificationLogger] Pruned ${toDelete} old records`);
      }
    } catch (error) {
      console.warn('[VerificationLogger] Failed to prune old records:', error);
    }
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Check if using in-memory fallback
   */
  isInMemoryFallback(): boolean {
    return this.inMemoryFallback;
  }
}
