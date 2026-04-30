/**
 * T-005: Dynamic electron-builder configuration supporting stealth build options.
 *
 * - NATIVELY_BUNDLE_NAME: overrides the app binary name (e.g. "SystemHelper")
 * - NATIVELY_DEFAULT_STEALTH=1: adds LSUIElement=true to macOS Info.plist
 */

const baseProductName = process.env.NATIVELY_BUNDLE_NAME || 'Natively';

const macExtendInfo = {
  NSMicrophoneUsageDescription:
    'Natively needs microphone access to capture meeting audio and voice input.',
  NSScreenCaptureUsageDescription:
    'Natively needs screen recording access so you can capture screenshots and analyze on-screen meeting content.',
  NSAppleEventsUsageDescription:
    'Natively needs automation access for desktop integrations you trigger from the app.',
};

if (process.env.NATIVELY_DEFAULT_STEALTH === '1') {
  macExtendInfo.LSUIElement = true;
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.electron.meeting-notes',
  afterPack: './scripts/ad-hoc-sign.js',
  productName: baseProductName,
  files: [
    'dist',
    'dist-electron',
    'electron/renderer',
    'package.json',
    'node_modules',
    '!**/native-module/target',
    '!**/native-module/src',
    '!**/native-module/.cargo',
  ],
  asarUnpack: [
    '**/*.node',
    '**/*.dylib',
    'dist-electron/electron/preload.js',
    'dist-electron/electron/preload/**',
    'dist-electron/electron/stealth/shellPreload.js',
  ],
  directories: {
    output: 'release',
    buildResources: 'assets',
  },
  extraResources: [
    {
      from: 'assets/',
      to: 'assets/',
    },
    {
      from: 'assets/natively.icns',
      to: 'natively.icns',
    },
    {
      from: 'resources/models/',
      to: 'models/',
    },
    {
      from: 'assets/bin/macos/system-services-helper',
      to: 'bin/macos/system-services-helper',
    },
    {
      from: 'assets/bin/macos',
      to: 'bin/macos',
      filter: ['foundation-intent-helper'],
    },
  ],
  extraFiles: [
    {
      from: 'assets/xpcservices/macos-full-stealth-helper.xpc',
      to: 'XPCServices/macos-full-stealth-helper.xpc',
    },
  ],
  mac: {
    category: 'public.app-category.productivity',
    extendInfo: macExtendInfo,
    target: [
      {
        target: 'zip',
        arch: ['x64', 'arm64'],
      },
      {
        target: 'dmg',
        arch: ['x64', 'arm64'],
      },
    ],
    icon: 'assets/natively.icns',
    identity: null,
    hardenedRuntime: true,
    entitlements: 'assets/entitlements.mac.plist',
    entitlementsInherit: 'assets/entitlements.mac.plist',
  },
  win: {
    target: [
      {
        target: 'nsis',
        arch: ['x64', 'ia32'],
      },
      {
        target: 'portable',
        arch: ['x64'],
      },
    ],
    icon: 'assets/icons/win/icon.ico',
    requestedExecutionLevel: 'asInvoker',
  },
  linux: {
    target: [
      {
        target: 'AppImage',
        arch: ['x64'],
      },
      {
        target: 'deb',
        arch: ['x64'],
      },
    ],
    icon: 'assets/icons/png/',
    category: 'Office',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
  },
  publish: [
    {
      provider: 'github',
      owner: 'evinjohnn',
      repo: 'natively-cluely-ai-assistant',
      releaseType: 'release',
    },
  ],
};
