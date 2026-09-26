import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, readFile, stat } from 'node:fs/promises';
import { endianness } from 'node:os';
import { basename, join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

async function verify(file, expected) {
  if ((await stat(file)).size !== expected.bytes) {
    throw new Error(`Laya file has the wrong size: ${basename(file)}.`);
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest('hex') !== expected.sha256) {
    throw new Error(`Laya file failed verification: ${basename(file)}.`);
  }
}

async function readAt(file, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, position + offset);
    if (!bytesRead) throw new Error('The Laya checkpoint is incomplete.');
    offset += bytesRead;
  }
}

async function writeAt(file, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset, position + offset);
    if (!bytesWritten) throw new Error('Could not write the converted Laya model.');
    offset += bytesWritten;
  }
}

export async function convertLaya({ checkpoint, directory, templates }, onProgress = () => {}) {
  if (endianness() !== 'LE') throw new Error('Laya conversion requires a little-endian processor.');
  const mapping = JSON.parse(await readFile(join(templates, 'mapping.json'), 'utf8'));
  await verify(checkpoint, mapping.checkpoint);
  const dataFiles = Object.entries(mapping.files).filter(([, file]) => file.tensors);
  const totalBytes = dataFiles.reduce((total, [, file]) => total + file.bytes, 0);
  let lastProgress = 0;
  const progress = (bytes) => {
    const now = Date.now();
    if (bytes === totalBytes || now - lastProgress >= 100) {
      lastProgress = now;
      onProgress(bytes);
    }
  };
  const chunkBytes = 1024 * 1024;
  const capacity = Math.max(chunkBytes, ...dataFiles.flatMap(([, file]) => file.tensors
    .filter((tensor) => tensor.transpose).map((tensor) => tensor.inputBytes)));
  if (capacity * 3 > 64 * 1024 * 1024) throw new Error('Laya conversion exceeds its memory limit.');
  const input = Buffer.allocUnsafe(capacity);
  const output = Buffer.allocUnsafe(capacity * 2);
  await mkdir(directory, { recursive: true });
  const source = await open(checkpoint, 'r');
  let completed = 0;
  try {
    for (const [name, file] of dataFiles) {
      const target = await open(join(directory, name), 'w');
      try {
        await target.truncate(file.bytes);
        for (const tensor of file.tensors) {
          let consumed = 0;
          while (consumed < tensor.inputBytes) {
            const bytes = tensor.transpose ? tensor.inputBytes : Math.min(chunkBytes, tensor.inputBytes - consumed);
            await readAt(source, input.subarray(0, bytes), tensor.inputOffset + consumed);
            const half = new Float16Array(input.buffer, input.byteOffset, bytes / 2);
            const single = new Float32Array(output.buffer, output.byteOffset, bytes / 2);
            if (tensor.transpose) {
              const [rows, columns] = tensor.shape;
              for (let row = 0; row < rows; row += 1) {
                for (let column = 0; column < columns; column += 1) {
                  single[column * rows + row] = half[row * columns + column];
                }
              }
            } else {
              single.set(half);
            }
            await writeAt(target, output.subarray(0, bytes * 2), tensor.outputOffset + consumed * 2);
            consumed += bytes;
            progress(completed + tensor.outputOffset + consumed * 2);
          }
        }
      } finally {
        await target.close();
      }
      completed += file.bytes;
      progress(completed);
    }
  } finally {
    await source.close();
  }
  for (const [name, file] of Object.entries(mapping.files)) {
    if (!file.tensors) await copyFile(join(templates, name), join(directory, name));
    await verify(join(directory, name), file);
  }
}

if (parentPort) {
  await convertLaya(workerData, (completed) => parentPort.postMessage(completed));
}
