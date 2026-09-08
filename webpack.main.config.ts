import { cp, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Configuration } from 'webpack';
import { nodeFileTrace } from '@vercel/nft';

import { rules } from './webpack.rules';
import { plugins } from './webpack.plugins';

const runtimeDependencies = ['@huggingface/transformers', '@audio/decode', 'wave-resampler'];

export const mainConfig: Configuration = {
  entry: { index: './src/main.ts', 'clap-worker': './src/main/clap-worker.ts' },
  output: { filename: '[name].js' },
  externals: Object.fromEntries(runtimeDependencies.map((name) => [name, `commonjs ${name}`])),
  module: { rules },
  plugins: [
    ...plugins,
    {
      apply(compiler) {
        compiler.hooks.afterEmit.tapPromise('CopyClapRuntime', async (compilation) => {
          const output = compilation.outputOptions.path;
          if (!output) throw new Error('Missing webpack output directory');
          const { fileList } = await nodeFileTrace(runtimeDependencies.map((name) => require.resolve(name)), {
            base: __dirname,
          });
          for (const file of [...fileList]) {
            if (!file.replaceAll('\\', '/').endsWith('/package.json')) continue;
            for (const name of await readdir(join(__dirname, dirname(file)))) {
              if (/^(license|copying|notice)/i.test(name)) fileList.add(join(dirname(file), name));
            }
          }
          await Promise.all([...fileList].filter((file) => {
            const path = file.replaceAll('\\', '/');
            const binary = /\/bin\/napi-v6\/([^/]+)\/([^/]+)\//.exec(path);
            return path.startsWith('node_modules/') && (binary === null || (binary[1] === process.platform && binary[2] === process.arch));
          }).map(async (file) => {
            const destination = join(output, file);
            await mkdir(dirname(destination), { recursive: true });
            await cp(join(__dirname, file), destination, { recursive: true });
          }));
        });
      },
    },
  ],
  resolve: { extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'] },
};
