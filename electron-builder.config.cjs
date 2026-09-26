const signedMac = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);
const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.joakimrosenfeldt.arsenal',
  productName: 'Arsenal',
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  directories: { output: 'dist' },
  files: [
    'package.json',
    { from: `.webpack/${process.arch}`, to: '.webpack', filter: ['**/*'] },
    '!node_modules/**/*',
  ],
  asar: true,
  extraResources: [
    { from: 'assets/icon.png', to: 'icon.png' },
    ...(existsSync('assets/laya') ? [{ from: 'assets/laya', to: 'laya' }] : []),
    { from: 'assets/laya-runtime', to: 'laya-runtime' },
    { from: 'assets/laya-runtime/node_modules', to: 'laya-runtime/node_modules' },
  ],
  beforePack: () => {
    execFileSync(process.execPath, ['scripts/prepare-laya.cjs', '--check', '--optional'], { stdio: 'inherit' });
    execFileSync(process.execPath, ['scripts/prepare-laya-runtime.mjs', '--check'], { stdio: 'inherit' });
  },
  npmRebuild: false,
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    loadBrowserProcessSpecificV8Snapshot: false,
    grantFileProtocolExtraPrivileges: false,
  },
  publish: {
    provider: 'github',
    owner: 'JoakimRosenfeldt',
    repo: 'arsenal',
    channel: `latest-${process.arch}`,
  },
  mac: {
    icon: 'assets/icon.icns',
    signIgnore: '/Contents/Resources/(?:laya/|laya-runtime/conversion/)',
    target: ['dmg', 'zip'],
    category: 'public.app-category.music',
    identity: signedMac ? undefined : '-',
    hardenedRuntime: signedMac,
    notarize: signedMac,
    forceCodeSigning: process.env.ARSENAL_RELEASE === 'true',
  },
  win: { target: ['nsis'], icon: 'assets/icon.ico' },
  nsis: { oneClick: true, perMachine: false },
  linux: {
    target: ['AppImage'],
    category: 'AudioVideo',
    icon: 'assets/icon.png',
  },
};
