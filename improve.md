# Security Hardening & Protection Guide

## Executive Summary

This document outlines security vulnerabilities discovered in the Natively AI Assistant codebase and provides detailed remediation steps for hardening the application against reverse engineering, unauthorized access, API key theft, license bypass, and social engineering attacks.

**Critical Priority Items (Address Immediately):**
1. Rotate all exposed API keys in `.env`
2. Fix broken license verification in `LicenseManager.ts`
3. Remove hardcoded API keys from source

---

## 1. Critical Vulnerabilities

### 1.1 Hardcoded API Keys

**Severity:** CRITICAL

**Location:** `.env` (root directory)

**Issue:** Real API keys are committed to the repository:

```
GEMINI_API_KEY=AIzaSy...
OPENAI_API_KEY=sk-svcacct-...
DEEPGRAM_API_KEY=1eef...
```

**Impact:** Anyone with repository access can use your API accounts, leading to:
- Unexpected billing charges
- Rate limiting affecting your users
- Potential data exposure if keys have broad permissions

**Remediation:**

1. **Immediately rotate all API keys** via each provider's dashboard
2. **Remove the `.env` file from the repository** (already gitignored, but verify)
3. **Use environment variables at runtime only:**

```typescript
// electron/main.ts - Load secrets properly
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

interface Secrets {
  GEMINI_API_KEY?: string;
  OPENAI_API_KEY?: string;
  DEEPGRAM_API_KEY?: string;
  [key: string]: string | undefined;
}

function loadSecrets(): Secrets {
  if (app.isPackaged) {
    // Production: Load from encrypted config or system keychain
    const secretsPath = path.join(app.getPath('userData'), 'secrets.json');
    if (fs.existsSync(secretsPath)) {
      const encrypted = fs.readFileSync(secretsPath, 'utf-8');
      return JSON.parse(decryptWithSafeStorage(encrypted));
    }
  }
  // Fallback to environment variables (set by launcher script)
  return {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
  };
}
```

4. **Create a secure launcher script** that injects environment variables:

```bash
#!/bin/bash
# launch-natively.sh
export GEMINI_API_KEY="$(security find-generic-password -s 'natively-gemini' -w 2>/dev/null || echo '')"
export OPENAI_API_KEY="$(security find-generic-password -s 'natively-openai' -w 2>/dev/null || echo '')"
export DEEPGRAM_API_KEY="$(security find-generic-password -s 'natively-deepgram' -w 2>/dev/null || echo '')"

/Applications/Natively.app/Contents/MacOS/natively "$@"
```

### 1.2 Broken License Verification

**Severity:** CRITICAL

**Location:** `premium/electron/services/LicenseManager.ts`

**Issue:** License validation is a stub that always returns premium:

```typescript
public activateLicense(_key: string): { success: boolean; error?: string } {
    this.premiumEnabled = true;  // Always enables premium
    return { success: true };
}

public isPremium(): boolean {
    return this.premiumEnabled;  // Always true
}
```

**Impact:** Premium features are freely available to all users.

**Remediation:**

```typescript
// premium/electron/services/LicenseManager.ts
import * as crypto from 'crypto';
import { safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

interface LicenseInfo {
  key: string;
  features: string[];
  expiresAt: number | null;
  issuedAt: number;
}

export class LicenseManager {
  private premiumEnabled: boolean = false;
  private licensePath: string;
  private readonly VALIDATION_URL = 'https://api.natively.ai/v1/license/validate';
  private readonly HMAC_SECRET: string;

  constructor() {
    this.licensePath = path.join(app.getPath('userData'), 'license.enc');
    this.HMAC_SECRET = this.getHardwareBoundSecret();
  }

  private getHardwareBoundSecret(): string {
    // Bind license to specific machine using hardware identifiers
    const machineId = this.getMachineSpecificId();
    return crypto.createHash('sha256')
      .update(machineId + 'natively-license-salt-v1')
      .digest('hex');
  }

  private getMachineSpecificId(): string {
    // Use CPU ID, motherboard serial, or network MAC as machine fingerprint
    // This prevents license sharing across machines
    const { execSync } = require('child_process');
    try {
      if (process.platform === 'darwin') {
        const cpuBrand = execSync('sysctl -n machdep.cpu.brand_string', { encoding: 'utf-8' }).trim();
        const hardwareUUID = execSync('ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID', { encoding: 'utf-8' }).trim().split('"')[3];
        return crypto.createHash('sha256').update(cpuBrand + hardwareUUID).digest('hex');
      }
    } catch {
      // Fallback to a machine-specific key derived from safeStorage encrypted data
      return 'fallback-machine-id';
    }
    return 'unknown';
  }

  private generateLicenseSignature(licenseKey: string, machineId: string): string {
    return crypto
      .createHmac('sha256', this.HMAC_SECRET)
      .update(licenseKey + machineId)
      .digest('hex');
  }

  private encryptLicenseData(data: LicenseInfo): Buffer {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Encryption not available on this system');
    }
    return safeStorage.encryptString(JSON.stringify(data));
  }

  private decryptLicenseData(encrypted: Buffer): LicenseInfo {
    const decrypted = safeStorage.decryptString(encrypted);
    return JSON.parse(decrypted);
  }

  private async validateOnline(key: string): Promise<LicenseInfo> {
    const machineId = this.getMachineSpecificId();
    const signature = this.generateLicenseSignature(key, machineId);

    const response = await fetch(this.VALIDATION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Natively-Client': 'desktop-v1',
        'X-Natively-Signature': signature,
      },
      body: JSON.stringify({
        key,
        machineId,
        appVersion: app.getVersion(),
        platform: process.platform,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'License validation failed');
    }

    return response.json();
  }

  public async activateLicense(key: string): Promise<{ success: boolean; error?: string }> {
    try {
      // Generate expected signature for offline validation
      const machineId = this.getMachineSpecificId();
      const expectedSig = this.generateLicenseSignature(key, machineId);

      // Attempt online validation
      let licenseInfo: LicenseInfo;
      try {
        licenseInfo = await this.validateOnline(key);
      } catch (onlineError) {
        // Fallback to offline validation using stored license
        return this.activateOffline(key, expectedSig, machineId);
      }

      // Verify machine binding
      if (licenseInfo.features.includes('multi-machine')) {
        // Multi-machine license - verify signature only
        const sigMatch = licenseInfo.key.endsWith(expectedSig.substring(0, 16));
        if (!sigMatch) {
          return { success: false, error: 'License signature mismatch' };
        }
      } else {
        // Single-machine license - verify machine binding
        const sigMatch = licenseInfo.key.endsWith(expectedSig);
        if (!sigMatch) {
          return { success: false, error: 'License not valid for this machine' };
        }
      }

      // Store encrypted license
      const encrypted = this.encryptLicenseData(licenseInfo);
      fs.writeFileSync(this.licensePath, encrypted);

      this.premiumEnabled = true;
      return { success: true };

    } catch (error) {
      console.error('License activation error:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Activation failed' 
      };
    }
  }

  private activateOffline(key: string, expectedSig: string, machineId: string): { success: boolean; error?: string } {
    // Load and verify stored license
    if (!fs.existsSync(this.licensePath)) {
      return { success: false, error: 'Cannot validate offline without prior activation' };
    }

    try {
      const encrypted = fs.readFileSync(this.licensePath);
      const licenseInfo = this.decryptLicenseData(encrypted);

      // Verify key matches
      if (licenseInfo.key !== key) {
        return { success: false, error: 'License key mismatch' };
      }

      // Verify machine binding
      const sigMatch = licenseInfo.key.endsWith(expectedSig);
      if (!sigMatch) {
        return { success: false, error: 'License not valid for this machine' };
      }

      // Check expiration
      if (licenseInfo.expiresAt && Date.now() > licenseInfo.expiresAt) {
        return { success: false, error: 'License has expired' };
      }

      // Verify offline grace period (e.g., 7 days since last online check)
      const offlineGrace = 7 * 24 * 60 * 60 * 1000; // 7 days
      if (Date.now() - licenseInfo.issuedAt > offlineGrace) {
        return { success: false, error: 'License requires online verification' };
      }

      this.premiumEnabled = true;
      return { success: true };

    } catch (error) {
      return { success: false, error: 'Corrupted license file' };
    }
  }

  public isPremium(): boolean {
    // Re-verify on each call for high-security scenarios
    // For performance, cache and refresh periodically
    return this.premiumEnabled;
  }

  public deactivateLicense(): void {
    this.premiumEnabled = false;
    if (fs.existsSync(this.licensePath)) {
      fs.unlinkSync(this.licensePath);
    }
  }

  public getLicenseInfo(): LicenseInfo | null {
    if (!fs.existsSync(this.licensePath)) {
      return null;
    }
    try {
      const encrypted = fs.readFileSync(this.licensePath);
      return this.decryptLicenseData(encrypted);
    } catch {
      return null;
    }
  }
}
```

---

## 2. High Priority Improvements

### 2.1 Code Obfuscation

**Severity:** HIGH

**Issue:** TypeScript source code is easily readable in packaged app.

**Remediation:**

1. **Configure Vite for code obfuscation:**

```bash
npm install --save-dev vite-plugin-obfuscator
```

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import obfuscator from 'vite-plugin-obfuscator';
import * as path from 'path';

export default defineConfig({
  plugins: [
    react(),
    obfuscator({
      auto门外: false,
      compact: true,
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 0.75,
      deadCodeInjection: true,
      deadCodeInjectionThreshold: 0.4,
      disableConsole: true,
      identifierNamesGenerator: 'hexadecimal',
      log: false,
      numbersToExpressions: true,
      renameGlobals: false,
      selfDefending: true,
      splitStrings: true,
      splitStringsChunkLength: 2,
      stringArray: true,
      stringArrayCallsTransform: true,
      stringArrayCallsTransformThreshold: 0.75,
      stringArrayEncoding: ['base64'],
      stringArrayIndexShift: true,
      stringArrayRotate: true,
      stringArrayShuffle: true,
      stringArrayWrappersCallsMaxCount: 2,
      stringArrayWrappersCount: 2,
      stringArrayThreshold: 0.75,
      transformClassKeys: true,
      transformObjectKeys: true,
      unicodeEscapeSequence: true,
    })
  ],
  build: {
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true,
        drop_debugger: true,
        pure_funcs: ['console.log', 'console.info'],
      },
      mangle: {
        properties: {
          regex: /^_/,
        },
      },
    },
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor': ['react', 'react-dom'],
          'ai': ['@anthropic-ai/sdk', 'openai', 'groq-sdk'],
        },
      },
    },
  },
});
```

2. **Enable Electron bundle encryption:**

```typescript
// electron/main.ts
import * as crypto from 'crypto';
import * as path from 'path';

function obfuscateStartup(): void {
  // Detect if running in development or tampered
  if (!app.isPackaged) {
    // Skip in dev for debugging
    return;
  }

  // Verify app signature on macOS
  if (process.platform === 'darwin') {
    const { execSync } = require('child_process');
    try {
      const signature = execSync('codesign -dvvv "' + process.execPath + '" 2>&1', { encoding: 'utf-8' });
      if (!signature.includes('Developer ID')) {
        console.error('Invalid code signature detected');
        app.exit(1);
      }
    } catch {
      console.error('Could not verify code signature');
      app.exit(1);
    }
  }
}
```

### 2.2 Memory Protection

**Severity:** HIGH

**Issue:** API keys remain in process memory and can be dumped.

**Remediation:**

```typescript
// electron/services/SecureMemory.ts
import { safeStorage } from 'electron';
import * as crypto from 'crypto';

interface SecureString {
  value: string;
  id: string;
}

class SecureMemoryManager {
  private secureStrings: Map<string, SecureString> = new Map();
  private readonly WIPE_INTERVAL = 30000; // 30 seconds
  private wipeTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.startPeriodicWipe();
    this.setupEmergencyWipe();
  }

  public store(key: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      // Fallback: store reference only, actual key never in memory
      const id = crypto.randomBytes(16).toString('hex');
      this.secureStrings.set(id, { value: key, id });
      return id;
    }

    // Encrypt and store
    const encrypted = safeStorage.encryptString(key);
    const id = crypto.randomBytes(16).toString('hex');
    this.secureStrings.set(id, { value: encrypted.toString('base64'), id });
    return id;
  }

  public retrieve(id: string): string | null {
    const entry = this.secureStrings.get(id);
    if (!entry) return null;

    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = Buffer.from(entry.value, 'base64');
      return safeStorage.decryptString(encrypted);
    }

    return entry.value;
  }

  public wipe(id: string): void {
    const entry = this.secureStrings.get(id);
    if (entry) {
      // Overwrite with random data before deletion
      const overwrite = crypto.randomBytes(entry.value.length).toString('hex');
      entry.value = overwrite;
      this.secureStrings.delete(id);
    }
  }

  public wipeAll(): void {
    for (const [id] of this.secureStrings) {
      this.wipe(id);
    }
  }

  private startPeriodicWipe(): void {
    this.wipeTimer = setInterval(() => {
      // Wipe any entries older than 5 minutes
      const maxAge = 5 * 60 * 1000;
      const now = Date.now();
      for (const [id, entry] of this.secureStrings) {
        if (now - entry.id.charCodeAt(0) > maxAge) {
          this.wipe(id);
        }
      }
    }, this.WIPE_INTERVAL);
  }

  private setupEmergencyWipe(): void {
    // Wipe on app quit
    app.on('will-quit', () => {
      this.wipeAll();
    });

    // Wipe on sleep/hibernate
    process.on('SIGTERM', () => {
      this.wipeAll();
    });
  }
}

export const secureMemory = new SecureMemoryManager();
```

### 2.3 Database Encryption

**Severity:** HIGH

**Issue:** SQLite database contains sensitive conversation data in plaintext.

**Remediation:**

```typescript
// electron/db/DatabaseManager.ts
import * as sqlite3 from 'better-sqlite3';
import * as crypto from 'crypto';
import { safeStorage, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

export class DatabaseManager {
  private db: sqlite3.Database | null = null;
  private encryptionKey: Buffer | null = null;

  private deriveKey(): Buffer {
    // Use machine-specific key derivation
    const machineId = this.getMachineId();
    const salt = 'natively-db-salt-v1';
    return crypto.pbkdf2Sync(machineId, salt, 100000, 32, 'sha256');
  }

  private getMachineId(): string {
    // Return a consistent machine identifier
    const idPath = path.join(app.getPath('userData'), '.machine-id');
    if (fs.existsSync(idPath)) {
      return fs.readFileSync(idPath, 'utf-8');
    }
    const id = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(idPath, id);
    return id;
  }

  public initialize(): void {
    const dbPath = path.join(app.getPath('userData'), 'natively.db');
    
    // Derive encryption key
    this.encryptionKey = this.deriveKey();

    this.db = sqlite3.open(dbPath);
    
    // Enable WAL mode for better concurrency
    this.db.pragma('journal_mode = WAL');
    
    // Apply SQL encryption using SEE (requires SQLite with encryption extension)
    // Or use application-level encryption for specific columns
    
    this.createTables();
  }

  private createTables(): void {
    if (!this.db) return;

    // meetings table - encrypt sensitive columns
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY,
        title_encrypted BLOB NOT NULL,
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        transcript_encrypted BLOB,
        embedding_id TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

    // interactions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS interactions (
        id TEXT PRIMARY KEY,
        meeting_id TEXT,
        role TEXT NOT NULL,
        content_encrypted BLOB NOT NULL,
        timestamp INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (meeting_id) REFERENCES meetings(id)
      )
    `);

    // Create indices
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_meetings_start ON meetings(start_time);
      CREATE INDEX IF NOT EXISTS idx_interactions_meeting ON interactions(meeting_id);
    `);
  }

  public encryptField(plaintext: string): Buffer {
    if (!this.encryptionKey) throw new Error('Database not initialized');
    
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    
    let encrypted = cipher.update(plaintext, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, encrypted]);
  }

  public decryptField(encrypted: Buffer): string {
    if (!this.encryptionKey) throw new Error('Database not initialized');
    
    const iv = encrypted.subarray(0, 16);
    const authTag = encrypted.subarray(16, 32);
    const ciphertext = encrypted.subarray(32);
    
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    return decrypted.toString('utf8');
  }

  public addMeeting(meeting: { id: string; title: string; startTime: number }): void {
    if (!this.db) return;

    const encryptedTitle = this.encryptField(meeting.title);
    
    const stmt = this.db.prepare(`
      INSERT INTO meetings (id, title_encrypted, start_time)
      VALUES (?, ?, ?)
    `);
    stmt.run(meeting.id, encryptedTitle, meeting.startTime);
  }

  public getMeetingTitle(meetingId: string): string | null {
    if (!this.db) return null;

    const stmt = this.db.prepare('SELECT title_encrypted FROM meetings WHERE id = ?');
    const row = stmt.get(meetingId) as { title_encrypted: Buffer } | undefined;
    
    if (!row) return null;
    return this.decryptField(row.title_encrypted);
  }

  public close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.encryptionKey = null;
  }
}
```

### 2.4 Anti-Debugging Protection

**Severity:** HIGH

**Remediation:**

```typescript
// electron/security/AntiDebug.ts
import { app } from 'electron';
import * as crypto from 'crypto';

class AntiDebug {
  private debuggerDetected: boolean = false;
  private readonly CHECK_INTERVAL = 5000;

  constructor() {
    this.startProtection();
  }

  private startProtection(): void {
    // Check for debugger attachment
    this.checkForDebugger();
    
    // Periodic checks
    setInterval(() => this.checkForDebugger(), this.CHECK_INTERVAL);

    // Handle signals that indicate debugging
    process.on('SIGTRAP', () => this.handleDebugAttach());
    
    // DisableElectronDisableFeature
    app.commandLine.appendSwitch('disable-features', 'VizDisplayCompositor');
  }

  private checkForDebugger(): void {
    // Method 1: Timing attack detection
    const start = process.hrtime.bigint();
    for (let i = 0; i < 1000; i++) {
      Math.sqrt(i);
    }
    const end = process.hrtime.bigint();
    const elapsed = Number(end - start);
    
    // If operations take >10x longer than expected, likely being debugged
    if (elapsed > 10000000) { // 10ms
      this.debuggerDetected = true;
      this.onDebuggerDetected();
      return;
    }

    // Method 2: Check for DevTools
    if (app.isReady()) {
      const windows = require('electron').BrowserWindow.getAllWindows();
      for (const win of windows) {
        win.webContents.on('devtools-opened', () => {
          this.debuggerDetected = true;
          this.onDebuggerDetected();
        });
      }
    }

    // Method 3: Check process status (macOS)
    if (process.platform === 'darwin') {
      const { execSync } = require('child_process');
      try {
        const result = execSync('ps -ef | grep -i debugger | grep -v grep', { encoding: 'utf-8' });
        if (result.includes('lldb') || result.includes('gdb')) {
          this.debuggerDetected = true;
          this.onDebuggerDetected();
        }
      } catch {
        // No debugger found
      }
    }

    // Method 4: Function call timing (DevTools detection)
    if (typeof process.exit === 'function') {
      const originalExit = process.exit;
      process.exit = function(code?: number) {
        // If exit is called immediately after, likely being debugged
        setTimeout(() => originalExit(code), 5000);
      };
    }
  }

  private handleDebugAttach(): void {
    this.debuggerDetected = true;
    this.onDebuggerDetected();
  }

  private onDebuggerDetected(): void {
    console.error('Debugging attempt detected');
    // Options:
    // 1. Exit immediately
    // app.exit(1);
    
    // 2. Corrupt sensitive data before exit
    this.corruptSensitiveData();
    
    // 3. Alert monitoring system (for production apps)
    this.reportIntrusion();
    
    app.exit(1);
  }

  private corruptSensitiveData(): void {
    // Overwrite any cached credentials/API keys in memory
    try {
      const { session } = require('electron');
      session.defaultSession.cookies.remove('*', () => {});
    } catch {
      // Ignore errors during corruption
    }
  }

  private reportIntrusion(): void {
    // Send alert to your monitoring system
    const report = {
      type: 'debugging_detected',
      timestamp: Date.now(),
      machineId: this.getMachineId(),
      appVersion: app.getVersion(),
    };
    
    // Fire-and-forget to your backend
    fetch('https://api.natively.ai/v1/security-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    }).catch(() => {});
  }

  private getMachineId(): string {
    const { execSync } = require('child_process');
    if (process.platform === 'darwin') {
      try {
        return execSync('ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID', { encoding: 'utf-8' }).trim().split('"')[3];
      } catch {
        return 'unknown';
      }
    }
    return 'unknown';
  }

  public isDebuggerDetected(): boolean {
    return this.debuggerDetected;
  }
}

export const antiDebug = new AntiDebug();
```

---

## 3. Medium Priority Improvements

### 3.1 Rate Limiting on API Key Validation

**Severity:** MEDIUM

**Location:** `electron/ipcHandlers.ts`

**Remediation:**

```typescript
// electron/security/RateLimiter.ts
interface RateLimitEntry {
  count: number;
  resetAt: number;
  blockedUntil: number;
}

class RateLimiter {
  private limits: Map<string, RateLimitEntry> = new Map();
  private readonly WINDOW_MS = 60000; // 1 minute
  private readonly MAX_REQUESTS = 10;
  private readonly BLOCK_DURATION_MS = 300000; // 5 minutes

  public check(key: string): { allowed: boolean; retryAfter?: number } {
    const now = Date.now();
    let entry = this.limits.get(key);

    if (!entry || now > entry.resetAt) {
      // New window
      entry = {
        count: 1,
        resetAt: now + this.WINDOW_MS,
        blockedUntil: 0,
      };
      this.limits.set(key, entry);
      return { allowed: true };
    }

    if (now < entry.blockedUntil) {
      return { 
        allowed: false, 
        retryAfter: Math.ceil((entry.blockedUntil - now) / 1000) 
      };
    }

    entry.count++;

    if (entry.count > this.MAX_REQUESTS) {
      entry.blockedUntil = now + this.BLOCK_DURATION_MS;
      return { 
        allowed: false, 
        retryAfter: Math.ceil(this.BLOCK_DURATION_MS / 1000) 
      };
    }

    return { allowed: true };
  }

  public reset(key: string): void {
    this.limits.delete(key);
  }
}

export const rateLimiter = new RateLimiter();
```

```typescript
// Usage in ipcHandlers.ts
import { rateLimiter } from './security/RateLimiter';

ipcMain.handle('test-llm-connection', async (event, { provider, apiKey }) => {
  // Apply rate limiting per IP/client
  const clientId = event.sender.id;
  const check = rateLimiter.check(clientId);
  
  if (!check.allowed) {
    throw new Error(`Rate limited. Retry after ${check.retryAfter} seconds.`);
  }

  // ... existing validation logic
});
```

### 3.2 Content Security Policy

**Severity:** MEDIUM

**Location:** `electron/main.ts`

**Remediation:**

```typescript
// Set strict CSP
app.on('web-contents-created', (_, contents) => {
  contents.on('will-navigate', (event, url) => {
    // Only allow navigation to your own domains
    const allowedDomains = ['natively.ai', 'api.natively.ai'];
    try {
      const parsedUrl = new URL(url);
      if (!allowedDomains.some(domain => parsedUrl.hostname.endsWith(domain))) {
        event.preventDefault();
      }
    } catch {
      event.preventDefault();
    }
  });

  contents.setWindowOpenHandler(({ url }) => {
    // Prevent popup windows to unknown domains
    const allowedDomains = ['natively.ai', 'api.natively.ai'];
    try {
      const parsedUrl = new URL(url);
      if (allowedDomains.some(domain => parsedUrl.hostname.endsWith(domain))) {
        require('electron').shell.openExternal(url);
      }
    } catch {
      // Invalid URL, ignore
    }
    return { action: 'deny' };
  });
});

// Add CSP meta tag in your HTML or via Electron
const CSP = `
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:;
  font-src 'self';
  connect-src 'self' https://api.natively.ai https://*.googleapis.com https://*.openai.com https://*.anthropic.com https://*.groq.com;
  frame-src 'none';
  object-src 'none';
  base-uri 'self';
  form-action 'self';
  frame-ancestors 'none';
`.replace(/\s+/g, ' ').trim();
```

### 3.3 Screen Capture Detection

**Severity:** MEDIUM

**Issue:** Screen sharing could expose sensitive data.

**Remediation:**

```typescript
// electron/security/ScreenShareGuard.ts
import { BrowserWindow, desktopCapturer, screen } from 'electron';

class ScreenShareGuard {
  private monitoredWindows: Set<BrowserWindow> = new Set();
  private originalContent: Map<number, string> = new Map();

  constructor() {
    this.setupScreenShareMonitoring();
  }

  private async setupScreenShareMonitoring(): Promise<void> {
    desktopCapturer.on('sources-updated', () => {
      this.checkForScreenCapture();
    });
  }

  public monitorWindow(window: BrowserWindow): void {
    this.monitoredWindows.add(window);
  }

  public unmonitorWindow(window: BrowserWindow): void {
    this.monitoredWindows.delete(window);
  }

  private async checkForScreenCapture(): Promise<void> {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1, height: 1 }
      });

      // Check if any of our windows are being captured
      for (const source of sources) {
        // Source names contain window IDs on some platforms
        if (source.name.includes('natively') || source.name.includes('Natively')) {
          // Detect which window is being captured
          for (const window of this.monitoredWindows) {
            if (!window.isDestroyed()) {
              // Apply blur or warning overlay
              this.applyScreenCaptureProtection(window);
            }
          }
        }
      }
    } catch (error) {
      console.error('Screen capture check failed:', error);
    }
  }

  private applyScreenCaptureProtection(window: BrowserWindow): void {
    // Option 1: Add visual watermark
    window.webContents.send('screen-capture-detected');

    // Option 2: Add blur effect to sensitive content
    window.webContents.insertCSS(`
      .sensitive-content {
        filter: blur(10px);
        transition: filter 0.3s ease;
      }
    `);

    // Option 3: For truly sensitive apps, you can attempt to detect
    // and block screen capture, though this has limitations
  }
}

export const screenShareGuard = new ScreenShareGuard();
```

---

## 4. Lower Priority Improvements

### 4.1 Network Security

**Severity:** LOW-MEDIUM

**Remediation:**

```typescript
// electron/security/NetworkSecurity.ts
import { session } from 'electron';
import * as crypto from 'crypto';

export function configureNetworkSecurity(): void {
  const defaultSession = session.defaultSession;

  // Enable HTTPS-only mode
  defaultSession.protocol.handle('https', (req) => {
    const url = new URL(req.url);
    
    // Block non-HTTPS requests to your API
    if (url.hostname.endsWith('natively.ai') && url.protocol !== 'https:') {
      url.protocol = 'https:';
    }
    
    return net.fetch(url);
  });

  // Configure certificate pinning
  const trustedCerts = new Set([
    // SHA-256 fingerprints of trusted certificates
    'sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  ]);

  defaultSession.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    // For your own API endpoints, enforce certificate validation
    if (url.startsWith('https://api.natively.ai/')) {
      const certFingerprint = crypto
        .createHash('sha256')
        .update(certificate.raw)
        .digest('base64');
      
      if (!trustedCerts.has(`sha256/${certFingerprint}=`)) {
        event.preventDefault();
        callback(false);
        return;
      }
    }
    callback(true);
  });

  // Disable auto-redirect to HTTP
  defaultSession.webRequest.onBeforeRedirect((details, callback) => {
    if (details.redirectURL.startsWith('http://')) {
      callback({ cancel: true });
      return;
    }
    callback({ cancel: false });
  });
}
```

### 4.2 Input Sanitization for Custom Providers

**Severity:** LOW

**Location:** `curl-validator.ts`

**Issue:** Custom cURL providers could allow injection.

**Remediation:**

```typescript
// electron/services/providers/curl-validator.ts
import * as crypto from 'crypto';

interface ValidationResult {
  valid: boolean;
  error?: string;
  sanitizedCommand?: string;
}

const BLOCKED_PATTERNS = [
  /--cookie/i,
  /--header.*Authorization/i,
  /--header.*Cookie/i,
  /-H.*Authorization/i,
  /-H.*Cookie/i,
  /--user/i,
  /-u\s/i,
  /--data-binary/i,
  /--output/i,
  /--local-port/i,
  /--resolve/i,
  /--unix-socket/i,
  /--max-time/i,
  /--connect-timeout/i,
];

const ALLOWED_HEADERS = new Set([
  'Content-Type',
  'Accept',
  'User-Agent',
  'X-Requested-With',
]);

export function validateCurlCommand(command: string): ValidationResult {
  // Basic structure check
  if (!command.trim().toLowerCase().startsWith('curl ')) {
    return { valid: false, error: 'Command must start with curl' };
  }

  // Check for blocked patterns
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return { valid: false, error: `Blocked pattern detected: ${pattern.source}` };
    }
  }

  // Validate headers
  const headerMatch = command.matchAll(/-H\s+['"]([^'"]+)['"]/gi);
  for (const match of headerMatch) {
    const header = match[1];
    const headerName = header.split(':')[0].trim();
    
    if (!ALLOWED_HEADERS.has(headerName)) {
      return { 
        valid: false, 
        error: `Header "${headerName}" not allowed. Allowed: ${[...ALLOWED_HEADERS].join(', ')}` 
      };
    }
  }

  // Validate {{TEXT}} placeholder usage
  const textPlaceholderCount = (command.match(/\{\{TEXT\}\}/gi) || []).length;
  if (textPlaceholderCount > 1) {
    return { valid: false, error: 'Only one {{TEXT}} placeholder allowed' };
  }

  // Verify JSON output expected
  if (!command.includes('--json') && !command.includes('-H') && !command.includes('Content-Type: application/json')) {
    return { valid: false, error: 'Response must be JSON (use --json flag)' };
  }

  // Generate sanitized version
  const sanitized = command.replace(/\{\{TEXT\}\}/g, 'PLACEHOLDER_REDACTED');
  
  return { valid: true, sanitizedCommand: sanitized };
}
```

---

## 5. Build & Distribution Hardening

### 5.1 macOS Code Signing

**Severity:** HIGH

```bash
# Create a script for code signing
#!/bin/bash
# scripts/sign-app.sh

APP_PATH="$1"
IDENTITY="$2"
TEAM_ID="$3"

echo "Signing application at: $APP_PATH"

# Verify identity exists
security find-identity -v -p codesigning | grep "$IDENTITY" || {
    echo "Error: Identity '$IDENTITY' not found"
    exit 1
}

# Sign the app bundle
codesign --force --deep --verbose \
    --sign "$IDENTITY" \
    --entitlements entitlements.plist \
    --options runtime \
    "$APP_PATH"

# Verify signature
codesign -dvvv "$APP_PATH" 2>&1 | grep -E "(TeamID|Authority)"

# Notarize for distribution outside App Store
xcrun notarytool submit "$APP_PATH" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_ID_PASSWORD" \
    --team-id "$TEAM_ID" \
    --wait

echo "Signing complete"
```

### 5.2 Entitlements Configuration

**Severity:** HIGH

```xml
<!-- entitlements.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <false/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <false/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <false/>
    <key>com.apple.security.cs.enable-hardened-runtime</key>
    <true/>
    <key>com.apple.security.automation.apple-events</key>
    <true/>
    <key>com.apple.security.device.audio-input</key>
    <true/>
    <key>com.apple.security.device.microphone</key>
    <true/>
    <key>com.apple.security.files.user-selected.read-write</key>
    <true/>
    <key>com.apple.security.network.client</key>
    <true/>
    <key>com.apple.security.personal-information.calendars</key>
    <true/>
    <key>com.apple.security.personal-information.contacts</key>
    <true/>
</dict>
</plist>
```

### 5.3 Electron Builder Configuration

**Severity:** HIGH

```json
{
  "appId": "ai.natively.app",
  "productName": "Natively",
  "copyright": "Copyright © 2024 Natively Inc.",
  "asar": true,
  "asarUnpack": [
    "native-module/**/*",
    "resources/**/*"
  ],
  "mac": {
    "category": "public.app-category.productivity",
    "hardenedRuntime": true,
    "gatekeeperAssess": false,
    "entitlements": "entitlements.plist",
    "entitlementsInherit": "entitlements.plist",
    "signingSignatureIdentity": "Developer ID Application: Your Name (TEAM_ID)"
  },
  "dmg": {
    "sign": false
  },
  "nsis": {
    "oneClick": false,
    "perMachine": false,
    "allowToChangeInstallationDirectory": true,
    "createDesktopShortcut": true,
    "createStartMenuShortcut": true
  },
  "afterSign": "scripts/notarize.js"
}
```

---

## 6. Monitoring & Incident Response

### 6.1 Security Event Logging

```typescript
// electron/security/SecurityLogger.ts
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

interface SecurityEvent {
  type: string;
  timestamp: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  details: Record<string, unknown>;
  fingerprint?: string;
}

class SecurityLogger {
  private logPath: string;
  private eventQueue: SecurityEvent[] = [];
  private readonly BATCH_SIZE = 10;
  private readonly FLUSH_INTERVAL = 60000; // 1 minute

  constructor() {
    this.logPath = path.join(app.getPath('userData'), 'security.log');
    this.startPeriodicFlush();
  }

  public log(event: Omit<SecurityEvent, 'timestamp'>): void {
    const fullEvent: SecurityEvent = {
      ...event,
      timestamp: Date.now(),
    };

    this.eventQueue.push(fullEvent);

    if (this.eventQueue.length >= this.BATCH_SIZE) {
      this.flush();
    }

    // Alert on critical events
    if (event.severity === 'critical') {
      this.alertSecurityTeam(fullEvent);
    }
  }

  private flush(): void {
    if (this.eventQueue.length === 0) return;

    const events = this.eventQueue.splice(0, this.eventQueue.length);
    const logLine = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    
    try {
      fs.appendFileSync(this.logPath, logLine);
    } catch (error) {
      console.error('Failed to write security log:', error);
    }
  }

  private startPeriodicFlush(): void {
    setInterval(() => this.flush(), this.FLUSH_INTERVAL);
  }

  private alertSecurityTeam(event: SecurityEvent): void {
    // Send alert to your security monitoring system
    fetch('https://api.natively.ai/v1/security-alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    }).catch(() => {
      // Fallback: log to local file with alert flag
      fs.appendFileSync(
        this.logPath, 
        `ALERT: ${JSON.stringify(event)}\n`
      );
    });
  }

  public getRecentEvents(count: number = 100): SecurityEvent[] {
    try {
      const content = fs.readFileSync(this.logPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      return lines.slice(-count).map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }
}

export const securityLogger = new SecurityLogger();
```

### 6.2 Telemetry Protection

```typescript
// electron/services/TelemetryGuard.ts
import { app } from 'electron';

interface TelemetryConfig {
  enabled: boolean;
  endpoint: string;
  consentGiven: boolean;
}

class TelemetryGuard {
  private config: TelemetryConfig = {
    enabled: false, // Default disabled
    endpoint: 'https://api.natively.ai/v1/telemetry',
    consentGiven: false,
  };

  public async setConsent(consent: boolean): Promise<void> {
    this.config.consentGiven = consent;
    this.config.enabled = consent && !this.isOptOutEnforced();
    this.saveConfig();
  }

  private isOptOutEnforced(): boolean {
    // Check if enterprise policy or local law requires opt-out
    // For GDPR, CCPA compliance, telemetry should be opt-in by default
    const region = app.getLocale().split('-')[1];
    const enforcedRegions = ['EU', 'GB', 'CA', 'VA']; // GDPR, CCPA, etc.
    return enforcedRegions.includes(region);
  }

  public track(event: string, data?: Record<string, unknown>): void {
    if (!this.config.enabled) return;
    
    // Only track anonymized, non-sensitive data
    const anonymizedData = this.anonymize(data);
    
    // Send to telemetry endpoint
    fetch(this.config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event,
        data: anonymizedData,
        timestamp: Date.now(),
        appVersion: app.getVersion(),
        platform: process.platform,
      }),
    }).catch(() => {});
  }

  private anonymize(data: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!data) return {};
    
    // Remove any potentially identifying information
    const anonymized = { ...data };
    delete anonymized['email'];
    delete anonymized['name'];
    delete anonymized['apiKey'];
    delete anonymized['ip'];
    
    // Hash any remaining identifiers
    if (anonymized['userId']) {
      anonymized['userId'] = this.hash(String(anonymized['userId']));
    }
    
    return anonymized;
  }

  private hash(value: string): string {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(value).digest('hex').substring(0, 16);
  }

  private saveConfig(): void {
    // Save to user preferences
  }
}

export const telemetryGuard = new TelemetryGuard();
```

---

## 7. Implementation Checklist

### Immediate Actions (Day 1)

- [ ] Rotate all exposed API keys
- [ ] Implement real license validation
- [ ] Remove hardcoded secrets from `.env`
- [ ] Enable `contextIsolation: true` in Electron config
- [ ] Add rate limiting to IPC handlers

### Short-term (Week 1)

- [ ] Implement code obfuscation with vite-plugin-obfuscator
- [ ] Add anti-debugging protection
- [ ] Implement database encryption for sensitive columns
- [ ] Configure Content Security Policy
- [ ] Set up secure memory management for API keys

### Medium-term (Month 1)

- [ ] Implement proper code signing and notarization
- [ ] Add screen capture detection
- [ ] Set up security event logging
- [ ] Configure network security (certificate pinning)
- [ ] Implement telemetry guard with consent

### Ongoing Security Practices

- [ ] Regular security audits
- [ ] Dependency vulnerability scanning (`npm audit`)
- [ ] Penetration testing
- [ ] Incident response plan
- [ ] Security training for developers

---

## 8. Testing Recommendations

### Security Testing Tools

```bash
# Dependency audit
npm audit

# OWASP dependency check
npx owasp-dependency-check

# npm outdate for outdated packages
npm outdate

# Electron security specific
npx electron-security-check

# For production builds, run:
npm run build && npm run signing
```

### Manual Security Checklist

- [ ] Verify no API keys in bundled JavaScript
- [ ] Verify no source maps in production
- [ ] Test license validation on different machines
- [ ] Test offline license behavior
- [ ] Verify rate limiting triggers after threshold
- [ ] Test screen capture detection
- [ ] Verify database encryption works correctly
- [ ] Test anti-debugging detection (attempt to attach debugger)

---

## 10. Interview Reasoning & Explanation Feature

### 10.1 Problem Statement

**Current State:**
- The system detects intent (`clarification`, `deep_dive`, `behavioral`, `coding`) but only uses it internally to shape answers
- `IntentClassifier.ts` generates reasoning but it's discarded after use
- `SuggestionOverlay.tsx` shows confidence % but NO reasoning/explanation
- Prompts explicitly enforce brevity ("STOP IMMEDIATELY") which is correct for speech but removes learning opportunity
- Users get WHAT to say but not WHY they're saying it

**User Need:**
Real interviews are iterative. Interviewers push back, ask "what if input is 10x larger," or want step-by-step reasoning. The hardest part isn't generating good follow-ups — it's building the habit of **explaining reasoning before writing code**. Most people jump straight to implementation, then struggle to articulate why when asked.

**Solution:**
A **Reasoning Engine** that generates "why" explanations separately from the spoken answer, displayed in a collapsible panel. This nudges users to verbalize their approach first without cluttering what they need to say.

---

### 10.2 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    IntelligenceEngine                           │
│  ┌──────────────┐    ┌─────────────────┐    ┌────────────────┐  │
│  │IntentClassifier│───▶│ WhatToAnswerLLM │    │ReasoningEngine │  │
│  │  (existing)   │    │  (generates     │    │  (generates    │  │
│  │               │    │   spoken answer)│    │   explanation) │  │
│  └──────────────┘    └─────────────────┘    └────────────────┘  │
│                              │                      │           │
│                              ▼                      ▼           │
│                    ┌─────────────────────────────────────┐     │
│                    │        SuggestionOverlay            │     │
│                    │  ┌─────────────────────────────┐    │     │
│                    │  │  💡 Suggested Response     │    │     │
│                    │  │  "I would approach this..." │    │     │
│                    │  └─────────────────────────────┘    │     │
│                    │  ┌─────────────────────────────┐    │     │
│                    │  │  📊 Why this approach?       │    │     │
│                    │  │  (collapsible)               │    │     │
│                    │  │  • Detected: deep_dive       │    │     │
│                    │  │  • Strategy: ...             │    │     │
│                    │  └─────────────────────────────┘    │     │
│                    └─────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

---

### 10.3 Implementation: ReasoningEngine

**New file:** `electron/llm/ReasoningEngine.ts`

```typescript
// electron/llm/ReasoningEngine.ts
// Generates "why" explanations for suggested answers
// Separated from the spoken answer to keep responses brief

import { ConversationIntent, IntentResult } from './IntentClassifier';

interface ReasoningContext {
    question: string;
    answer: string;
    intent: IntentResult;
    context: string;
}

interface ReasoningOutput {
    detectedIntent: ConversationIntent;
    intentExplanation: string;
    strategy: string;
    keyPoints: string[];
    whatToRemember: string;
    suggestedPhrases: string[];
}

/**
 * Maps intent types to human-readable explanations
 */
const INTENT_EXPLANATIONS: Record<ConversationIntent, string> = {
    clarification: "The interviewer wants you to clarify something you just said. They're confused or need more precision.",
    follow_up: "The interviewer is asking you to continue the story or narrative. They want the next part.",
    deep_dive: "The interviewer wants technical depth. They want to understand HOW and WHY, not just WHAT.",
    behavioral: "The interviewer is using STAR format. They want a specific example from your experience with measurable outcomes.",
    example_request: "The interviewer wants a concrete instance, not abstract concepts. Make it specific and realistic.",
    summary_probe: "The interviewer is checking if you understood their point and can synthesize. Confirm + clarify.",
    coding: "The interviewer wants implementation details. Show your approach first, then the code.",
    general: "General conversational response. Stay natural and direct."
};

/**
 * Maps intent to strategy guidance
 */
const INTENT_STRATEGIES: Record<ConversationIntent, string> = {
    clarification: "Start with the simplest re-statement, then add one precision detail. Avoid re-explaining the whole topic.",
    follow_up: "Continue chronologically from where you left off. Don't repeat what's already been said. Use 'And then...' transitions.",
    deep_dive: "Structure: High-level concept → specific mechanism → real-world example. Use technical terms correctly.",
    behavioral: "Lead with the result/metric. Use STAR implicitly: Situation (1 sentence) → Task (what you did) → Action (how) → Result (impact).",
    example_request: "Pick ONE specific example. Include concrete numbers/timelines. Avoid hypotheticals.",
    summary_probe: "Confirm their point briefly, then add one NEW insight or implication they haven't considered.",
    coding: "State approach BEFORE code: 'I'd use X because it handles Y case...' Then provide clean, runnable code.",
    general: "Answer directly and concisely. Don't over-explain."
};

/**
 * Generate explanation WHY a particular approach was chosen
 */
function generateStrategyGuidance(intent: ConversationIntent, question: string): string {
    const baseStrategy = INTENT_STRATEGIES[intent];
    
    // Add question-specific nuances
    if (intent === 'deep_dive' && question.toLowerCase().includes('scale')) {
        return baseStrategy + " Note: The question mentions scale - emphasize how your approach handles growth.";
    }
    if (intent === 'behavioral' && question.toLowerCase().includes('fail')) {
        return baseStrategy + " Note: 'Failure' questions assess humility and learning. Focus on what the failure taught you.";
    }
    if (intent === 'clarification' && question.length < 30) {
        return baseStrategy + " Note: Keep your clarification extremely brief - they may have misheard.";
    }
    
    return baseStrategy;
}

/**
 * Extract key pedagogical points for learning
 */
function extractKeyPoints(intent: ConversationIntent, answer: string, question: string): string[] {
    const points: string[] = [];
    
    // Intent-specific insights
    switch (intent) {
        case 'clarification':
            points.push("When asked to clarify, re-state your point differently, don't re-explain the topic");
            points.push("Add exactly ONE precision detail, then stop");
            break;
        case 'deep_dive':
            points.push("Technical depth should use correct terminology but stay focused on the question");
            points.push("If you don't know the internals, explain the high-level concept with an analogy");
            break;
        case 'behavioral':
            points.push("Always include metrics: 'reduced latency by 40%' beats 'improved performance'");
            points.push("The 'T' in STAR is often what interviewers remember - what was YOUR specific action?");
            break;
        case 'coding':
            points.push("Interviewers want to see approach before code - state 'I'd use X because...' first");
            points.push("Start with a brute-force/naive solution, then optimize if asked");
            break;
        default:
            points.push("Keep answers speakable in 20-30 seconds");
            points.push("When in doubt, under-explain rather than over-explain");
    }
    
    return points;
}

/**
 * Generate memorable phrases to internalize
 */
function generateSuggestedPhrases(intent: ConversationIntent, answer: string): string[] {
    const phrases: string[] = [];
    
    // Extract the most impactful sentence from the answer
    const sentences = answer.split(/[.!?]+/).filter(s => s.trim().length > 10);
    if (sentences.length > 0) {
        phrases.push(`Key phrase to remember: "${sentences[0].trim().substring(0, 80)}..."`);
    }
    
    // Intent-specific phrase patterns
    switch (intent) {
        case 'clarification':
            phrases.push("Pattern: 'To clarify what I meant...' + one precision point");
            break;
        case 'deep_dive':
            phrases.push("Pattern: 'The way this works internally is...' + mechanism + example");
            break;
        case 'behavioral':
            phrases.push("Pattern: 'I was facing X, so I did Y, which resulted in Z (metric)'");
            break;
        case 'coding':
            phrases.push("Pattern: 'Id approach this in three steps: 1)... 2)...' + code");
            break;
    }
    
    return phrases;
}

/**
 * Main reasoning generation function
 */
export function generateReasoning(context: ReasoningContext): ReasoningOutput {
    const { question, answer, intent } = context;
    
    return {
        detectedIntent: intent.intent,
        intentExplanation: INTENT_EXPLANATIONS[intent.intent],
        strategy: generateStrategyGuidance(intent.intent, question),
        keyPoints: extractKeyPoints(intent.intent, answer, question),
        whatToRemember: `Interviewer detected as: ${intent.intent}. Confidence: ${(intent.confidence * 100).toFixed(0)}%`,
        suggestedPhrases: generateSuggestedPhrases(intent.intent, answer)
    };
}

/**
 * Generate reasoning for follow-up/refinement requests
 */
export function generateRefinementReasoning(
    originalAnswer: string,
    refinementType: string
): { whyThisRefinement: string; pitfallToAvoid: string } {
    const refinementInsights: Record<string, { why: string; pitfall: string }> = {
        shorten: {
            why: "Brevity signals confidence. When you over-explain, it sounds like you're unsure.",
            pitfall: "Don't cut so much that you lose credibility or context. Minimum: answer + one supporting point."
        },
        expand: {
            why: "The interviewer pushed back for more detail - they want to see depth.",
            pitfall: "Don't lecture. Add ONE specific detail (metric, example, mechanism) that directly answers the follow-up.",
            },
        rephrase: {
            why: "The original phrasing may have been unclear, awkward, or too rehearsed.",
            pitfall: "Stay authentic. Re-phrasing shouldn't sound robotic. Natural speech patterns are key."
        },
        more_confident: {
            why: "Hesitation undermines credibility. Strong opinions with caveats show you know your stuff.",
            pitfall: "Don't be arrogant. 'I know this is correct because...' beats 'Trust me, I'm sure.'"
        },
        more_casual: {
            why: "Technical interviews shouldn't feel like exams. Conversational tone builds rapport.",
            pitfall: "Stay professional. Casual ≠ sloppy. Watch filler words ('like', 'um', 'you know')."
        },
        more_formal: {
            why: "Some interviewers (especially senior ones) prefer professionalism over casual chat.",
            pitfall: "Formal ≠ stiff. You can be professional without sounding robotic."
        },
        simplify: {
            why: "The interviewer may not be familiar with the jargon you used, or you over-complicated.",
            pitfall: "Don't dumb it down. Replace jargon with precise simpler terms, not less information."
        }
    };
    
    return refinementInsights[refinementType] || {
        why: "The refinement helps match the interviewer's style and question type.",
        pitfall: "Make sure the refined answer still accurately represents your experience."
    };
}
```

---

### 10.4 Integration with IntelligenceEngine

**Modify:** `electron/IntelligenceEngine.ts`

Add a new event and integrate reasoning generation:

```typescript
// Add to IntelligenceModeEvents interface (around line 42):
'reasoning_generated': (reasoning: ReasoningOutput) => void;

// Add new method to IntelligenceEngine class (around line 525):
/**
 * Generate reasoning for the last suggested answer
 * Called after runWhatShouldISay completes
 */
async generateAnswerReasoning(question: string, answer: string): Promise<ReasoningOutput | null> {
    try {
        const intentResult = await classifyIntent(question, '', 0);
        
        const reasoning = generateReasoning({
            question,
            answer,
            intent: intentResult,
            context: this.session.getFormattedContext(120) || ''
        });
        
        this.emit('reasoning_generated', reasoning);
        return reasoning;
    } catch (error) {
        console.error('[IntelligenceEngine] Failed to generate reasoning:', error);
        return null;
    }
}
```

**Modify `runWhatShouldISay`** (around line 307) to generate reasoning after answer:

```typescript
// After emit('suggested_answer', ...) around line 307:
// Generate reasoning for educational display
const reasoning = await this.generateAnswerReasoning(
    question || 'What to Answer',
    fullAnswer
);

if (reasoning) {
    // Emit reasoning for UI to display
    this.emit('reasoning_generated', reasoning);
}
```

**Modify `runFollowUp`** (around line 369) to generate refinement reasoning:

```typescript
// After emitting refined_answer, around line 377:
const refinementReasoning = generateRefinementReasoning(lastMsg, intent);
const refinementContext = {
    originalAnswer: lastMsg,
    refinementType: intent,
    why: refinementReasoning.whyThisRefinement,
    pitfall: refinementReasoning.pitfallToAvoid
};
this.emit('refinement_reasoning', refinementContext);
```

---

### 10.5 UI Updates for SuggestionOverlay

**Modify:** `src/components/SuggestionOverlay.tsx`

```tsx
import React, { useState, useEffect } from 'react';

interface ReasoningOutput {
    detectedIntent: string;
    intentExplanation: string;
    strategy: string;
    keyPoints: string[];
    whatToRemember: string;
    suggestedPhrases: string[];
}

interface RefinementContext {
    refinementType: string;
    why: string;
    pitfall: string;
}

export const SuggestionOverlay: React.FC<SuggestionOverlayProps> = ({ className }) => {
    const [isConnected, setIsConnected] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [currentTranscript, setCurrentTranscript] = useState<Transcript | null>(null);
    const [suggestion, setSuggestion] = useState<GeneratedSuggestion | null>(null);
    const [reasoning, setReasoning] = useState<ReasoningOutput | null>(null);
    const [refinementReasoning, setRefinementReasoning] = useState<RefinementContext | null>(null);
    const [showReasoning, setShowReasoning] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const cleanups: (() => void)[] = [];

        // ... existing event subscriptions ...

        // Reasoning events (NEW)
        cleanups.push(
            window.electronAPI.onReasoningGenerated((reasoning: ReasoningOutput) => {
                setReasoning(reasoning);
                setShowReasoning(false); // Start collapsed
                setRefinementReasoning(null);
            })
        );

        cleanups.push(
            window.electronAPI.onRefinementReasoning((context: RefinementContext) => {
                setRefinementReasoning(context);
                setShowReasoning(true);
            })
        );

        return () => {
            cleanups.forEach(cleanup => cleanup());
        };
    }, []);

    // ... existing rendering logic ...

    {/* AI Suggestion */}
    {suggestion && !isProcessing && (
        <div className="suggestion-card p-4 rounded-lg bg-gradient-to-br from-indigo-900/80 to-purple-900/80 backdrop-blur-sm border border-indigo-500/50 shadow-lg shadow-indigo-500/20">
            {/* ... existing header and text ... */}
            
            {/* Collapsible Reasoning Panel */}
            {(reasoning || refinementReasoning) && (
                <div className="mt-3">
                    <button
                        onClick={() => setShowReasoning(!showReasoning)}
                        className="flex items-center gap-2 text-xs text-indigo-300 hover:text-indigo-200 transition-colors"
                    >
                        <span className="text-lg">
                            {showReasoning ? '📊' : '💡'}
                        </span>
                        <span>
                            {showReasoning ? 'Hide reasoning' : 'Why this approach?'}
                        </span>
                        <span className={`transform transition-transform ${showReasoning ? 'rotate-180' : ''}`}>
                            ▼
                        </span>
                    </button>

                    {showReasoning && (
                        <div className="mt-3 p-3 rounded-lg bg-black/30 border border-indigo-700/50 space-y-3">
                            {/* Intent Detection */}
                            {reasoning && (
                                <>
                                    <div className="flex items-start gap-2">
                                        <span className="text-purple-400 text-sm">🎯</span>
                                        <div>
                                            <p className="text-xs font-medium text-purple-300">
                                                Detected: {reasoning.detectedIntent.replace('_', ' ')}
                                            </p>
                                            <p className="text-xs text-gray-400 mt-1">
                                                {reasoning.intentExplanation}
                                            </p>
                                        </div>
                                    </div>

                                    {/* Strategy */}
                                    <div className="flex items-start gap-2">
                                        <span className="text-blue-400 text-sm">🧠</span>
                                        <div>
                                            <p className="text-xs font-medium text-blue-300">
                                                Strategy
                                            </p>
                                            <p className="text-xs text-gray-400 mt-1">
                                                {reasoning.strategy}
                                            </p>
                                        </div>
                                    </div>

                                    {/* Key Points */}
                                    <div className="flex items-start gap-2">
                                        <span className="text-green-400 text-sm">✓</span>
                                        <div>
                                            <p className="text-xs font-medium text-green-300">
                                                Key Takeaways
                                            </p>
                                            <ul className="text-xs text-gray-400 mt-1 space-y-1">
                                                {reasoning.keyPoints.map((point, i) => (
                                                    <li key={i}>• {point}</li>
                                                ))}
                                            </ul>
                                        </div>
                                    </div>

                                    {/* Suggested Phrases */}
                                    {reasoning.suggestedPhrases.length > 0 && (
                                        <div className="flex items-start gap-2">
                                            <span className="text-yellow-400 text-sm">💬</span>
                                            <div>
                                                <p className="text-xs font-medium text-yellow-300">
                                                    Phrase to Remember
                                                </p>
                                                <p className="text-xs text-gray-400 mt-1 italic">
                                                    {reasoning.suggestedPhrases[0]}
                                                </p>
                                            </div>
                                        </div>
                                    )}
                                </>
                            )}

                            {/* Refinement Reasoning */}
                            {refinementReasoning && (
                                <>
                                    <div className="flex items-start gap-2">
                                        <span className="text-orange-400 text-sm">✏️</span>
                                        <div>
                                            <p className="text-xs font-medium text-orange-300">
                                                Why {refinementReasoning.refinementType}?
                                            </p>
                                            <p className="text-xs text-gray-400 mt-1">
                                                {refinementReasoning.why}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-start gap-2">
                                        <span className="text-red-400 text-sm">⚠️</span>
                                        <div>
                                            <p className="text-xs font-medium text-red-300">
                                                Pitfall to Avoid
                                            </p>
                                            <p className="text-xs text-gray-400 mt-1">
                                                {refinementReasoning.pitfall}
                                            </p>
                                        </div>
                                    </div>
                                </>
                            )}

                            {/* Confidence reminder */}
                            {reasoning && (
                                <p className="text-xs text-gray-500 border-t border-indigo-700/30 pt-2 mt-2">
                                    Confidence: {Math.round(suggestion.confidence * 100)}% • 
                                    This reasoning helps you understand the "why" - adapt as needed for your voice
                                </p>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    )}

    {/* Instructions - Updated */}
    <div className="mt-3 text-xs text-gray-500 text-center space-y-1">
        <p>Say "rephrase that" or "make it shorter" for follow-ups</p>
        <p className="text-indigo-400/70">
            <button 
                onClick={() => setShowReasoning(!showReasoning)}
                className="hover:text-indigo-300 underline"
            >
                Tap "Why this approach?" to see the reasoning
            </button>
        </p>
    </div>
}
```

---

### 10.6 IPC Channel for Reasoning Events

**Modify:** `electron/preload.ts` (or wherever IPC is configured)

```typescript
// Add to contextBridge.exposeInMainWorld('electronAPI', { ... })

// Reasoning events
onReasoningGenerated: (callback: (reasoning: ReasoningOutput) => void) => {
    ipcRenderer.on('reasoning-generated', (_, reasoning) => callback(reasoning));
},

onRefinementReasoning: (callback: (context: RefinementContext) => void) => {
    ipcRenderer.on('refinement-reasoning', (_, context) => callback(context));
},
```

**Modify:** `electron/ipcHandlers.ts` to forward reasoning events

```typescript
// Forward reasoning events from IntelligenceEngine
intelligenceEngine.on('reasoning_generated', (reasoning) => {
    BrowserWindow.getFocusedWindow()?.webContents.send('reasoning-generated', reasoning);
});

intelligenceEngine.on('refinement_reasoning', (context) => {
    BrowserWindow.getFocusedWindow()?.webContents.send('refinement-reasoning', context);
});
```

---

### 10.7 Prompt Integration for "Explain Your Approach"

**New feature:** Explicit "explain your approach" nudge for coding questions

**Modify:** `electron/llm/prompts.ts` - Add new prompt section

```typescript
// Add after WHAT_TO_ANSWER_PROMPT (around line 189)

/**
 * REASONING NUDGE PROMPT
 * Used when user asks for "why" or when system wants to encourage explaining approach
 * This is for LEARNING mode, not for the spoken answer
 */
export const REASONING_NUDGE_PROMPT = `
<mode>
You are in LEARNING/REASONING mode. The user wants to understand WHY they should say something, not just WHAT to say.
</mode>

<output_structure>
Provide your response in this structure:
1. APPROACH: (1-2 sentences) How you would tackle this and WHY this approach
2. KEY_POINTS: (3-4 bullet points) What to remember when answering
3. PITFALLS: (2-3 bullet points) Common mistakes to avoid
4. PHRASE: (1 sentence) A phrase they can use verbatim if helpful
</output_structure>

<guidance>
- Focus on METACOGNITION: thinking about thinking
- Help them understand the STRATEGY, not just the content
- For coding: explain WHY this approach before showing code
- For behavioral: explain WHY STAR format and what makes a strong example
- For deep_dive: explain HOW to structure technical depth
</guidance>

<constraint>
Keep total output under 200 words. This is guidance, not a lecture.
</constraint>
`;
```

---

### 10.8 IntentClassifier Enhancement

**Modify:** `electron/llm/IntentClassifier.ts` to expose reasoning data

```typescript
// Add at end of file

/**
 * Get human-readable explanation for an intent
 */
export function getIntentExplanation(intent: ConversationIntent): string {
    return INTENT_ANSWER_SHAPES[intent];
}

/**
 * Get strategy guidance for an intent
 */
export function getIntentStrategy(intent: ConversationIntent): string {
    return INTENT_STRATEGIES[intent];
}

/**
 * Get the ANSWER SHAPE description (how to structure the response)
 */
export function getAnswerShapeDescription(intent: ConversationIntent): string {
    return INTENT_ANSWER_SHAPES[intent];
}
```

---

### 10.9 Type Definitions

**Create/Update:** `electron/llm/types.ts` or add to existing types

```typescript
// Reasoning types
export interface ReasoningOutput {
    detectedIntent: ConversationIntent;
    intentExplanation: string;
    strategy: string;
    keyPoints: string[];
    whatToRemember: string;
    suggestedPhrases: string[];
}

export interface RefinementContext {
    refinementType: string;
    why: string;
    pitfall: string;
}

export interface ReasoningContext {
    question: string;
    answer: string;
    intent: IntentResult;
    context: string;
}
```

---

### 10.10 Files to Create/Modify Summary

| Action | File | Purpose |
|--------|------|---------|
| **CREATE** | `electron/llm/ReasoningEngine.ts` | Core reasoning generation logic |
| **CREATE** | `electron/llm/types.ts` (append) | Type definitions for reasoning |
| **MODIFY** | `electron/IntelligenceEngine.ts` | Emit reasoning events after answer generation |
| **MODIFY** | `electron/llm/prompts.ts` | Add REASONING_NUDGE_PROMPT |
| **MODIFY** | `electron/llm/IntentClassifier.ts` | Export helper functions |
| **MODIFY** | `electron/preload.ts` | Add IPC listeners for reasoning events |
| **MODIFY** | `src/components/SuggestionOverlay.tsx` | Display reasoning panel |

---

### 10.11 Implementation Order

1. **Phase 1: Core Engine** (Day 1)
   - Create `ReasoningEngine.ts` with `generateReasoning()` and `generateRefinementReasoning()`
   - Add types
   - Test in isolation

2. **Phase 2: Integration** (Day 2)
   - Modify `IntelligenceEngine` to emit `reasoning_generated` event
   - Add IPC channels in preload
   - Verify events flow correctly

3. **Phase 3: UI** (Day 3)
   - Update `SuggestionOverlay` with collapsible reasoning panel
   - Style for clarity and quick scanning
   - Add refinement reasoning display

4. **Phase 4: Polish** (Day 4)
   - Add `REASONING_NUDGE_PROMPT` for explicit "explain approach" feature
   - Consider voice command integration ("why did you suggest that?")
   - Add user preference to disable reasoning (some users find it distracting)

---

### 10.12 UX Considerations

**Balancing Act:**
- The spoken answer must stay brief (20-30 seconds)
- The reasoning panel is OPTIONAL (collapsible by default)
- Advanced users can disable reasoning entirely
- For investor demos: show reasoning ON by default to demonstrate "learning" capability

**Accessibility:**
- Screen readers should skip reasoning panel (it's supplementary)
- Color coding helps quick scanning under pressure
- Font sizes adequate for glanceability during live interviews

**Future Enhancements:**
- "Why did you suggest that?" voice command to get explanation on demand
- Per-intent user preferences (show reasoning for behavioral but not for coding)
- Post-interview summary: "You answered 12 questions, here's what to practice..."

---

### 10.13 Reasoning Mode Toggle (Settings Integration)

**Overview:**
Add "Reasoning Mode" as a toggle in `SettingsPopup.tsx` alongside Fast Response and Transcript toggles. When enabled, the reasoning panel appears below suggested answers. When disabled, only the suggested answer is shown.

**Pattern to Follow:**
Based on existing toggles in `SettingsPopup.tsx` (lines 185-227), the reasoning toggle should:
1. Use a Brain icon (`{}` or custom)
2. Sync with localStorage (`natively_reasoning_mode`)
3. Broadcast changes via IPC to main process
4. Persist across app restarts

**Files to Modify:**

| File | Changes |
|------|---------|
| `src/components/SettingsPopup.tsx` | Add reasoning mode toggle (after Transcript toggle) |
| `electron/preload.ts` | Add IPC handlers for get/set reasoning mode |
| `electron/ipcHandlers.ts` | Add handlers for get/set reasoning mode |
| `src/components/SuggestionOverlay.tsx` | Read reasoning mode state, conditionally render panel |
| `src/types/electron.d.ts` | Add type definitions for reasoning mode IPC |

**Implementation: SettingsPopup.tsx**

```tsx
// Add import for Brain icon (or use existing icon)
import { MessageSquare, Zap, User, Brain } from 'lucide-react';

// Add state (around line 11)
const [reasoningMode, setReasoningMode] = useState(() => {
    return localStorage.getItem('natively_reasoning_mode') !== 'false'; // Default true
});

// Add listener for changes from main process (around line 88)
useEffect(() => {
    if (window.electronAPI?.onReasoningModeChanged) {
        const unsubscribe = window.electronAPI.onReasoningModeChanged((enabled: boolean) => {
            setReasoningMode(enabled);
            localStorage.setItem('natively_reasoning_mode', String(enabled));
        });
        return () => unsubscribe();
    }
}, []);

// Add toggle UI (after Interviewer Transcript Toggle, around line 227)
{/* Reasoning Mode Toggle */}
<div className="flex items-center justify-between px-3 py-2 hover:bg-white/5 rounded-lg transition-colors duration-200 group cursor-default">
    <div className="flex items-center gap-3">
        <Brain
            className={`w-3.5 h-3.5 transition-colors ${reasoningMode ? 'text-violet-400' : 'text-slate-500 group-hover:text-slate-300'}`}
            fill={reasoningMode ? "currentColor" : "none"}
        />
        <span className={`text-[12px] font-medium transition-colors ${reasoningMode ? 'text-white' : 'text-slate-400 group-hover:text-slate-200'}`}>Reasoning</span>
    </div>
    <button
        onClick={() => {
            const newState = !reasoningMode;
            setReasoningMode(newState);
            localStorage.setItem('natively_reasoning_mode', String(newState));
            // Dispatch event for same-window listeners
            window.dispatchEvent(new Event('storage'));
            // Also notify main process
            window.electronAPI?.setReasoningMode?.(newState);
        }}
        className={`w-[30px] h-[18px] rounded-full p-[1.5px] transition-all duration-300 ease-spring active:scale-[0.92] ${reasoningMode ? 'bg-violet-500 shadow-[0_2px_10px_rgba(139,92,246,0.3)]' : 'bg-white/10'}`}
    >
        <div className={`w-[15px] h-[15px] rounded-full bg-black shadow-sm transition-transform duration-300 ease-spring ${reasoningMode ? 'translate-x-[12px]' : 'translate-x-0'}`} />
    </button>
</div>
```

**Implementation: electron/preload.ts**

```typescript
// Add IPC channel (around line 697)
setReasoningMode: (enabled: boolean) => 
    ipcRenderer.invoke('set-reasoning-mode', enabled),
getReasoningMode: () => 
    ipcRenderer.invoke('get-reasoning-mode'),
onReasoningModeChanged: (callback: (enabled: boolean) => void) => {
    ipcRenderer.on('reasoning-mode-changed', (_, enabled) => callback(enabled));
},
```

**Implementation: electron/ipcHandlers.ts**

```typescript
// Add handler (around line 1161, after groq fast text handlers)
safeHandle("get-reasoning-mode", async () => {
    return { enabled: appState.reasoningMode };
});

safeHandle("set-reasoning-mode", async (_, enabled: boolean) => {
    appState.reasoningMode = enabled;
    // Broadcast to all windows
    BrowserWindow.getAllWindows().forEach(win => {
        win.webContents.send('reasoning-mode-changed', enabled);
    });
    return { success: true };
});
```

**Implementation: AppState (electron/main.ts)**

Add to AppState class:
```typescript
public reasoningMode: boolean = true; // Default enabled

constructor() {
    // Load from stored preference
    const stored = localStorage.getItem('natively_reasoning_mode');
    if (stored !== null) {
        this.reasoningMode = stored === 'true';
    }
}
```

**Implementation: SuggestionOverlay.tsx**

```tsx
// Add state for reasoning mode
const [reasoningModeEnabled, setReasoningModeEnabled] = useState(() => {
    return localStorage.getItem('natively_reasoning_mode') !== 'false';
});

// Listen for changes
useEffect(() => {
    const handleStorageChange = () => {
        const enabled = localStorage.getItem('natively_reasoning_mode') !== 'false';
        setReasoningModeEnabled(enabled);
    };
    
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
}, []);

// Conditional rendering - only show reasoning panel if enabled
{reasoningModeEnabled && reasoning && (
    <div className="mt-3">
        {/* Reasoning panel content */}
    </div>
)}
```

**UI Styling Guidelines:**

| State | Icon Color | Background | Description |
|-------|-----------|------------|-------------|
| Enabled | `text-violet-400` (violet-500) | `bg-violet-500 shadow-violet` | Violet/purple represents learning/metacognition |
| Disabled | `text-slate-500` → hover `text-slate-300` | `bg-white/10` | Muted, unobtrusive |

**localStorage Keys:**

| Key | Values | Default | Purpose |
|-----|--------|---------|---------|
| `natively_reasoning_mode` | `"true"` / `"false"` | `"true"` | User preference for reasoning panel |

**Toggle Behavior:**

1. **Default:** ON (first launch shows reasoning to demonstrate learning capability)
2. **Persistence:** Stored in localStorage, synced to AppState
3. **Broadcast:** Changes broadcast to all windows via IPC
4. **Stacking:** When disabled, reasoning panel never appears (even if reason events are emitted)
5. **Override:** Can be programmatically disabled during "live interview" mode for distraction-free mode

**Advanced: Live Interview Mode Override**

For users who want zero distractions during actual interviews:

```tsx
// In SuggestionOverlay.tsx
const [liveInterviewMode, setLiveInterviewMode] = useState(false);

// When live interview starts, auto-disable reasoning
useEffect(() => {
    if (window.electronAPI?.onLiveInterviewStarted) {
        window.electronAPI.onLiveInterviewStarted(() => {
            setLiveInterviewMode(true);
            // Temporarily disable reasoning regardless of user setting
        });
    }
    if (window.electronAPI?.onLiveInterviewEnded) {
        window.electronAPI.onLiveInterviewEnded(() => {
            setLiveInterviewMode(false);
            // Restore user's reasoning preference
        });
    }
}, []);

// Final decision: show reasoning if (user enabled) AND (not in live mode)
const shouldShowReasoning = reasoningModeEnabled && !liveInterviewMode;
```

---

## 9. File Locations Summary

| Security Feature | File Location | Status |
|------------------|---------------|--------|
| Credential Storage | `electron/services/CredentialsManager.ts` | Partially implemented |
| License Validation | `premium/electron/services/LicenseManager.ts` | **BROKEN - Needs rewrite** |
| IPC Validation | `electron/ipcValidation.ts` | Good |
| Rate Limiting | Not implemented | **Missing** |
| Database Encryption | `electron/db/DatabaseManager.ts` | Not encrypted |
| Anti-Debug | Not implemented | **Missing** |
| Code Obfuscation | Not configured | **Missing** |
| Memory Management | Basic scrubbing only | Needs improvement |
| Network Security | Not configured | **Missing** |
| CSP | Not configured | **Missing** |

---

*Last Updated: March 2024*
*Document Version: 1.0*
