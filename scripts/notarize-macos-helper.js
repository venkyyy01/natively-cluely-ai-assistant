const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
const helperPath = [
    path.join(root, 'assets', 'bin', 'macos', 'system-services-helper'),
    path.join(root, 'assets', 'bin', 'macos', 'stealth-virtual-display-helper'),
].find((candidate) => fs.existsSync(candidate));

function log(message) {
    process.stdout.write(`[notarize-macos-helper] ${message}\n`);
}

function run(command, args, options = {}) {
    try {
        return execFileSync(command, args, { 
            stdio: options.silent ? 'pipe' : 'inherit',
            ...options 
        });
    } catch (error) {
        if (!options.silent) {
            throw error;
        }
        return null;
    }
}

async function notarize() {
    if (process.platform !== 'darwin') {
        log('Skipping notarization on non-macOS host');
        return;
    }

    if (!helperPath) {
        log('Helper binary not found, skipping notarization');
        return;
    }

    const appleId = process.env.APPLE_ID;
    const appleIdPassword = process.env.APPLE_ID_PASSWORD;
    const teamId = process.env.APPLE_TEAM_ID;

    if (!appleId || !appleIdPassword || !teamId) {
        log('Skipping notarization: APPLE_ID, APPLE_ID_PASSWORD, or APPLE_TEAM_ID not set');
        return;
    }

    log('Submitting helper for notarization...');
    
    run('xcrun', [
        'notarytool', 'submit',
        helperPath,
        '--apple-id', appleId,
        '--password', appleIdPassword,
        '--team-id', teamId,
        '--wait'
    ]);

    log('Stapling notarization ticket...');
    run('xcrun', ['stapler', 'staple', helperPath]);

    log('Notarization complete');
}

notarize().catch(error => {
    console.error('Notarization failed:', error.message);
    process.exit(1);
});
