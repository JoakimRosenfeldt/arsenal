import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const revision = '4066d5d5fbf08b66c6757ddeedbd797bd7655bc0';
const destination = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(destination, '../..');
const temporary = await mkdtemp(path.join(tmpdir(), 'arsenal-laya-sdk-'));
const modules = ['agent', 'common', 'hooks', 'providers', 'structured', 'tokenizer'];

try {
  await mkdir(path.join(temporary, 'src'));
  const download = async (file) => {
    const response = await fetch(`https://raw.githubusercontent.com/NandhaKishorM/laya/${revision}/${file}`);
    if (!response.ok) throw new Error(`Cannot download ${file}: HTTP ${response.status}`);
    return response.text();
  };
  await Promise.all(modules.map(async (name) => {
    await writeFile(path.join(temporary, 'src', `${name}.ts`), await download(`laya-ts/src/${name}.ts`));
  }));
  await writeFile(path.join(temporary, 'LICENSE'), await download('LICENSE'));
  await writeFile(path.join(temporary, 'package.json'), '{"type":"module"}\n');
  await writeFile(path.join(temporary, 'src', 'index.ts'), [
    'export { Agent, toInternal } from "./agent.js";',
    'export type { QuestionDef, ChoiceAnswer, ScoreAnswer, NoulAnswer, SystemAnswer, SystemOneResult } from "./agent.js";',
    'export { buildQuestionPrefix, serializeState } from "./common.js";',
    '',
  ].join('\n'));
  await writeFile(path.join(temporary, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      declaration: true,
      outDir: 'compiled',
      rootDir: 'src',
      types: ['node'],
      typeRoots: [path.join(root, 'node_modules', '@types')],
    },
    include: ['src'],
  }, null, 2));
  execFileSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(temporary, 'tsconfig.json')], { stdio: 'inherit' });
  for (const file of await readdir(path.join(temporary, 'compiled'))) {
    await copyFile(path.join(temporary, 'compiled', file), path.join(destination, file));
  }
  await copyFile(path.join(temporary, 'LICENSE'), path.join(destination, 'LICENSE'));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
