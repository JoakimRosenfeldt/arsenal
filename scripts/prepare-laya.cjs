const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createReadStream, existsSync, readFileSync, statSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const modelDir = path.join(root, 'assets', 'laya');
const embeddedManifest = path.join(root, 'src', 'shared', 'laya-model-manifest.json');
const revision = '55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851';
const sourceRevision = '4066d5d5fbf08b66c6757ddeedbd797bd7655bc0';

async function verify() {
  const manifest = JSON.parse(readFileSync(path.join(modelDir, 'manifest.json'), 'utf8'));
  if (manifest.modelRevision !== revision || manifest.sourceRevision !== sourceRevision) {
    throw new Error('The bundled Laya model is out of date. Run npm run prepare:laya.');
  }
  const conversion = JSON.parse(readFileSync(path.join(root, 'vendor', 'laya-conversion', 'mapping.json'), 'utf8'));
  for (const [name, expected] of Object.entries(conversion.files)) {
    const bundled = manifest.files[name];
    if (!bundled || bundled.bytes !== expected.bytes || bundled.sha256 !== expected.sha256) {
      throw new Error(`Laya does not match the conversion templates: ${name}. Run npm run prepare:laya.`);
    }
  }
  const requirementsHash = createHash('sha256')
    .update(readFileSync(path.join(__dirname, 'prepare-laya.requirements.txt'), 'utf8').replace(/\r\n/g, '\n'))
    .digest('hex');
  if (manifest.exportRequirementsSha256 !== requirementsHash) {
    throw new Error('The Laya export dependencies changed. Run npm run prepare:laya.');
  }
  for (const name of ['encoder.onnx', 'encoder.onnx.data', 'head.onnx', 'head.onnx.data',
    'tokenizer.json', 'rl_agent_config.json', 'LICENSE.txt', 'MODEL_CARD.md']) {
    if (!manifest.files[name]) throw new Error(`Laya manifest is missing ${name}.`);
  }
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (path.basename(name) !== name) throw new Error(`Invalid Laya asset name: ${name}`);
    const file = path.join(modelDir, name);
    if (statSync(file).size !== expected.bytes || expected.bytes <= 0) {
      throw new Error(`Laya asset is incomplete: ${name}`);
    }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    if (hash.digest('hex') !== expected.sha256) throw new Error(`Laya checksum failed: ${name}`);
  }
  const serialized = JSON.stringify(manifest, null, 2) + '\n';
  if (!existsSync(embeddedManifest) || readFileSync(embeddedManifest, 'utf8') !== serialized) {
    writeFileSync(embeddedManifest, serialized);
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}.`);
}

async function main() {
  if (process.argv.includes('--check')) {
    if (process.argv.includes('--optional') && !existsSync(modelDir)) {
      console.log('Laya is not bundled. Download it from the app before generating recommendations.');
      return;
    }
    await verify();
    return;
  }
  if (existsSync(path.join(modelDir, 'manifest.json'))) {
    try {
      await verify();
      console.log('Laya model is ready.');
      return;
    } catch (error) {
      console.log(`Rebuilding Laya: ${error.message}`);
    }
  }
  const venv = path.join(root, '.cache', 'laya', 'venv');
  const python = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!existsSync(python)) {
    run(process.env.LAYA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
      ['-m', 'venv', venv]);
  }
  run(python, ['-c', 'import sys; assert sys.version_info[:2] == (3, 12), "Set LAYA_PYTHON to Python 3.12 and remove .cache/laya/venv."']);
  run(python, ['-m', 'pip', 'install', '-r', 'scripts/prepare-laya.requirements.txt']);
  run(python, ['scripts/prepare-laya.py']);
  await verify();
}

main().catch((error) => {
  console.error(`Cannot prepare Laya: ${error.message}`);
  process.exitCode = 1;
});
