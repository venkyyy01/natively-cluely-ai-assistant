import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const helperPath = process.env.NATIVELY_MACOS_VIRTUAL_DISPLAY_HELPER || 
    path.join(process.cwd(), 'assets/bin/macos/stealth-virtual-display-helper');
const runNativeIntegration = process.env.NATIVELY_RUN_MACOS_VIRTUAL_DISPLAY_INTEGRATION === '1';

describe('MacOS Virtual Display Helper Integration', {
    skip: process.platform !== 'darwin' || !fs.existsSync(helperPath) || !runNativeIntegration,
}, () => {
    before(function() {
        if (!fs.existsSync(helperPath) || !runNativeIntegration) {
            this.skip();
        }
    });

    it('returns status with layer3 candidate report', async () => {
        const result = await runHelper(['status']);
        const status = JSON.parse(result);
        
        assert.strictEqual(status.component, 'macos-virtual-display-helper');
        assert.ok(['cgvirtualdisplay', 'unsupported'].includes(status.backend));
        assert.ok(typeof status.layer3Candidate === 'object');
    });

    it('probes capabilities', async () => {
        const result = await runHelper(['probe-capabilities']);
        const response = JSON.parse(result);
        
        assert.ok(['ok', 'blocked'].includes(response.outcome));
        assert.ok(response.data);
        assert.ok(response.data.candidateRenderer);
    });

    it('creates and releases session via serve mode', async () => {
        const child = spawn(helperPath, ['serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
        
        try {
            const response1 = await sendRequest(child, {
                id: 'test-1',
                command: 'create-session',
                sessionId: 'integration-test-1',
                windowId: 'window-1',
                width: 1280,
                height: 720
            });
            
            assert.strictEqual(response1.ok, true);
            assert.strictEqual(response1.result.sessionId, 'integration-test-1');

            const response2 = await sendRequest(child, {
                id: 'test-2',
                command: 'release-session',
                sessionId: 'integration-test-1'
            });
            
            assert.strictEqual(response2.ok, true);
        } finally {
            child.kill();
        }
    });

    it('handles probe-capabilities via serve mode', async () => {
        const child = spawn(helperPath, ['serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
        
        try {
            const response = await sendRequest(child, {
                id: 'probe-1',
                command: 'probe-capabilities'
            });
            
            assert.strictEqual(response.id, 'probe-1');
            assert.strictEqual(response.ok, true);
            assert.ok(response.result);
            assert.ok(response.result.data);
            assert.ok(response.result.data.candidateRenderer);
        } finally {
            child.kill();
        }
    });

    it('returns error for invalid command via serve mode', async () => {
        const child = spawn(helperPath, ['serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
        
        try {
            const response = await sendRequest(child, {
                id: 'invalid-1',
                command: 'unknown-command'
            });
            
            assert.strictEqual(response.ok, false);
            assert.ok(response.error);
        } finally {
            child.kill();
        }
    });
});

async function runHelper(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const helperPath = process.env.NATIVELY_MACOS_VIRTUAL_DISPLAY_HELPER || 
            path.join(process.cwd(), 'assets/bin/macos/stealth-virtual-display-helper');
        
        const child = spawn(helperPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        
        child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
        child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
        
        child.on('close', (code: number) => {
            if (code === 0) {
                resolve(stdout.trim());
            } else {
                reject(new Error(`Helper exited with code ${code}: ${stderr}`));
            }
        });
        
        child.on('error', reject);
    });
}

async function sendRequest(child: ReturnType<typeof spawn>, request: object): Promise<any> {
    return new Promise((resolve, reject) => {
        let buffer = '';
        const timeout = setTimeout(() => {
            reject(new Error('Request timeout'));
        }, 10000);
        
        const onData = (data: Buffer) => {
            buffer += data.toString();
            const newlineIndex = buffer.indexOf('\n');
            if (newlineIndex >= 0) {
                const line = buffer.slice(0, newlineIndex);
                clearTimeout(timeout);
                child.stdout?.off('data', onData);
                try {
                    resolve(JSON.parse(line));
                } catch (e) {
                    reject(e);
                }
            }
        };
        
        child.stdout?.on('data', onData);
        child.stdin?.write(JSON.stringify(request) + '\n');
    });
}
