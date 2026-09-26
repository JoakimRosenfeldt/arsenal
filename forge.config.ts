import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerZIP } from '@electron-forge/maker-zip';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { execFileSync } from 'node:child_process';

import { mainConfig } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    icon: './assets/icon',
    extraResource: ['./assets/icon.png', './assets/laya', './assets/laya-runtime'],
    osxSign: {
      identity: '-',
      identityValidation: false,
      ignore: '/Contents/Resources/laya/',
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false,
      optionsForFile: () => ({
        entitlements: [],
        hardenedRuntime: false,
        timestamp: 'none',
      }),
    },
  },
  rebuildConfig: {},
  hooks: {
    prePackage: async () => {
      execFileSync(process.execPath, ['scripts/prepare-laya.cjs', '--check'], { stdio: 'inherit' });
      execFileSync(process.execPath, ['scripts/prepare-laya-runtime.mjs', '--check'], { stdio: 'inherit' });
    },
  },
  makers: [new MakerZIP({}, ['darwin'])],
  plugins: [
    new WebpackPlugin({
      mainConfig,
      port: 3001,
      devContentSecurityPolicy:
        "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:* cuebox-media:; img-src 'self' data: cuebox-art:; media-src cuebox-media:; object-src 'none'; base-uri 'none'; form-action 'none'",
      renderer: {
        config: rendererConfig,
        entryPoints: [
          {
            html: './src/index.html',
            js: './src/renderer.tsx',
            name: 'main_window',
            preload: {
              js: './src/preload.ts',
            },
          },
        ],
      },
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    }),
  ],
};

export default config;
