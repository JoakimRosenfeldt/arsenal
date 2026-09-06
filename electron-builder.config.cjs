const signedMac = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);

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
    target: ['dmg', 'zip'],
    category: 'public.app-category.music',
    identity: signedMac ? undefined : '-',
    hardenedRuntime: signedMac,
    notarize: signedMac,
    forceCodeSigning: process.env.ARSENAL_RELEASE === 'true',
  },
  win: { target: ['nsis'] },
  nsis: { oneClick: true, perMachine: false },
  linux: { target: ['AppImage'], category: 'AudioVideo' },
};
