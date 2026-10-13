// node-taglib-sharp 6.0.3 sorts RIFF chunk indexes as strings, so saving a WAV whose tag chunks
// sit at indexes like 8 and 11 corrupts the write. Sort them as numbers until upstream fixes it.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const file = createRequire(import.meta.url).resolve('node-taglib-sharp/dist/riff/riffFile.js');
const source = readFileSync(file, 'utf8');
const fixed = 'taggingChunkIndexes.sort((a, b) => a - b);';
if (!source.includes(fixed)) {
  if (!source.includes('taggingChunkIndexes.sort();')) throw new Error(`Cannot patch ${file}; check whether the WAV chunk sort bug is fixed.`);
  writeFileSync(file, source.replace('taggingChunkIndexes.sort();', fixed));
}
