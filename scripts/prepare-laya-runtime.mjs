import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = join(root, 'assets', 'laya-runtime');
const modules = join(destination, 'node_modules');
const nativeDirectory = join('bin', 'napi-v6', process.platform, process.arch);
const runtimeVersion = JSON.parse(await readFile(join(root, 'node_modules/onnxruntime-node/package.json'), 'utf8')).version;
const manifest = { platform: process.platform, arch: process.arch, runtimeVersion };

if (!process.argv.includes('--check')) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(modules, { recursive: true });
  await cp(join(root, 'src/main/laya-worker.mjs'), join(destination, 'worker.mjs'));
  await cp(join(root, 'src/main/laya-converter.mjs'), join(destination, 'converter.mjs'));
  await cp(join(root, 'vendor/laya-conversion'), join(destination, 'conversion'), { recursive: true });
  await cp(join(root, 'vendor/laya'), join(modules, 'laya'), {
    recursive: true, filter: (source) => !source.endsWith('update.mjs'),
  });
  for (const name of ['onnxruntime-node', 'onnxruntime-common']) {
    const source = join(root, 'node_modules', name);
    const target = join(modules, name);
    await mkdir(target, { recursive: true });
    for (const file of ['package.json', 'README.md', 'dist']) {
      await cp(join(source, file), join(target, file), { recursive: true });
    }
    await cp(join(root, 'vendor/onnxruntime-LICENSE'), join(target, 'LICENSE'));
    await cp(join(root, 'vendor/onnxruntime-ThirdPartyNotices.txt'), join(target, 'ThirdPartyNotices.txt'));
    if (name === 'onnxruntime-node') {
      await cp(join(source, nativeDirectory), join(target, nativeDirectory), {
        recursive: true, dereference: true,
        filter: (file) => !/providers_(cuda|tensorrt)/u.test(file),
      });
    }
  }
  await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

const stored = JSON.parse(await readFile(join(destination, 'manifest.json'), 'utf8'));
if (JSON.stringify(stored) !== JSON.stringify(manifest)) {
  throw new Error('Laya runtime does not match this build. Run npm run prepare:laya-runtime.');
}
const sourceWorker = await readFile(join(root, 'src/main/laya-worker.mjs'));
const bundledWorker = await readFile(join(destination, 'worker.mjs'));
if (!sourceWorker.equals(bundledWorker)) throw new Error('Laya worker is stale. Run npm run prepare:laya-runtime.');
if (!(await readFile(join(root, 'src/main/laya-converter.mjs'))).equals(await readFile(join(destination, 'converter.mjs')))) {
  throw new Error('Laya converter is stale. Run npm run prepare:laya-runtime.');
}
for (const file of await readdir(join(root, 'vendor/laya-conversion'))) {
  if (!(await readFile(join(root, 'vendor/laya-conversion', file))).equals(await readFile(join(destination, 'conversion', file)))) {
    throw new Error('Laya conversion templates are stale. Run npm run prepare:laya-runtime.');
  }
}
const binding = join(modules, 'onnxruntime-node', nativeDirectory, 'onnxruntime_binding.node');
await readFile(binding);
for (const file of await readdir(join(root, 'vendor/laya'))) {
  if (file === 'update.mjs') continue;
  if (!(await readFile(join(root, 'vendor/laya', file))).equals(await readFile(join(modules, 'laya', file)))) {
    throw new Error('Laya SDK is stale. Run npm run prepare:laya-runtime.');
  }
}
const { default: ort } = await import(new URL('../assets/laya-runtime/node_modules/onnxruntime-node/dist/index.js', import.meta.url));
if (!ort.listSupportedBackends().some((provider) => provider.name === 'cpu' && provider.bundled)) {
  throw new Error('The bundled ONNX runtime has no CPU provider.');
}
console.info(`Laya runtime ready for ${process.platform}-${process.arch}: ${resolve(destination)}`);
