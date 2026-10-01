import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3-multiple-ciphers';
import { app } from 'electron';
import { SaxesParser } from 'saxes';

export type RekordboxDatabase = Database.Database;

export const isRekordboxDatabasePath = (path: string): boolean => /\.(?:db|sqlite)$/i.test(path);

// Rekordbox's shared SQLCipher key is documented by pyrekordbox. See THIRD_PARTY_NOTICES.md.
const databaseKey = Buffer.from('NDAyZmQ0ODJjMzg4MTdjMzVmZmE4ZmZiOGM3ZDkzMTQzYjc0OWU3ZDMxNWRmN2E4MTczMmExZmY0MzYwODQ5Nw==', 'base64');

const fileExists = async (path: string): Promise<boolean> => {
  try { return (await stat(path)).isFile(); } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw error;
  }
};

export const detectRekordboxDatabase = async (): Promise<string | null> => {
  const pioneer = process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Pioneer')
    : process.platform === 'win32'
      ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Pioneer') : null;
  if (pioneer === null) return null;
  const candidates: string[] = [];
  const optionsPath = join(pioneer, 'rekordboxAgent', 'storage', 'options.json');
  if (await fileExists(optionsPath)) {
    const data: unknown = JSON.parse(await readFile(optionsPath, 'utf8'));
    if (typeof data === 'object' && data !== null && 'options' in data && Array.isArray(data.options)) {
      for (const option of data.options) {
        if (Array.isArray(option) && option[0] === 'db-path' && typeof option[1] === 'string') candidates.push(option[1]);
      }
    }
  }
  const settingsPath = join(pioneer, 'rekordbox6', 'rekordbox3.settings');
  if (await fileExists(settingsPath)) {
    const parser = new SaxesParser();
    parser.on('opentag', (tag) => {
      if (tag.name === 'VALUE' && tag.attributes.name === 'masterDbDirectory' && typeof tag.attributes.val === 'string') {
        candidates.push(join(tag.attributes.val, 'master.db'));
      }
    });
    parser.write(await readFile(settingsPath, 'utf8')).close();
  }
  const existing = new Map<string, string>();
  for (const path of candidates) {
    if (!(await fileExists(path))) continue;
    const canonical = await realpath(path);
    existing.set(process.platform === 'win32' ? canonical.toLowerCase() : canonical, path);
  }
  if (existing.size > 1) throw new Error('Rekordbox has conflicting library locations. Open Rekordbox and confirm its library location before connecting.');
  const configured = existing.values().next().value;
  if (configured !== undefined) return configured;
  const fallback = join(pioneer, 'rekordbox', 'master.db');
  return await fileExists(fallback) ? fallback : null;
};

export class RekordboxRunningError extends Error {
  override readonly name = 'RekordboxRunningError';
  constructor() { super('Changes will sync automatically after Rekordbox closes.'); }
}

const includesRekordbox = (processes: string): boolean => processes.split(/\r?\n/).some((line) => process.platform === 'win32'
  ? /^"rekordbox\.exe"/i.test(line.trim())
  : /^rekordbox$/i.test(basename(line.trim())));

export const isRekordboxRunning = async (): Promise<boolean> => {
  const execute = promisify(execFile);
  const result = process.platform === 'win32'
    ? await execute('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })
    : await execute('ps', ['-A', '-o', 'comm='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
  return includesRekordbox(result.stdout);
};

export const assertRekordboxClosed = async (): Promise<void> => {
  if (await isRekordboxRunning()) throw new RekordboxRunningError();
};

export const assertRekordboxClosedSync = (): void => {
  const options = { timeout: 5000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' } as const;
  const processes = process.platform === 'win32'
    ? execFileSync('tasklist', ['/FO', 'CSV', '/NH'], options)
    : execFileSync('ps', ['-A', '-o', 'comm='], options);
  if (includesRekordbox(processes)) throw new RekordboxRunningError();
};

export const openRekordboxDatabase = async (
  path: string,
  { readonly = true }: Readonly<{ readonly?: boolean }> = {},
): Promise<RekordboxDatabase> => {
  if (!readonly) await assertRekordboxClosed();
  const file = await open(path, 'r');
  const header = Buffer.alloc(16);
  try { await file.read(header, 0, header.length, 0); } finally { await file.close(); }
  const nativeFile = `${process.platform}-${process.arch}.node`;
  const nativeBinding = app.isPackaged ? join(process.resourcesPath, nativeFile)
    : join(app.getAppPath(), 'node_modules', 'better-sqlite3-multiple-ciphers', 'prebuilds', nativeFile);
  const db = new Database(path, { readonly, fileMustExist: true, timeout: 3000, nativeBinding });
  try {
    if (header.toString() !== 'SQLite format 3\0') {
      db.pragma("cipher='sqlcipher'");
      db.pragma('legacy=4');
      db.key(databaseKey);
    }
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'djmdContent'").get()) {
      throw new Error('Choose a Rekordbox 6 or 7 library database.');
    }
    return db;
  } catch {
    db.close();
    throw new Error('Could not open this Rekordbox database. It may use an unsupported format or be unavailable.');
  }
};

const backupInterval = 60 * 60 * 1000;

// Ongoing sync writes after every edit, so a full copy of the database is made at most once an hour.
const recentBackup = async (root: string, name: string): Promise<boolean> => {
  let entries: string[];
  try { entries = await readdir(root); } catch { return false; }
  for (const entry of entries) {
    try { if ((await stat(join(root, entry, name))).mtimeMs > Date.now() - backupInterval) return true; } catch { /* Not a database backup. */ }
  }
  return false;
};

export const backupRekordboxDatabase = async (db: RekordboxDatabase, path: string): Promise<string[]> => {
  await assertRekordboxClosed();
  if (db.inTransaction) throw new Error('Back up the Rekordbox database before starting a transaction.');
  if (await recentBackup(join(dirname(path), 'arsenal-backups'), basename(path))) return [];
  const directory = join(dirname(path), 'arsenal-backups', `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const databaseBackup = join(directory, basename(path));
  // VACUUM INTO preserves SQLCipher encryption; the driver's backup API cannot copy encrypted databases.
  db.prepare('VACUUM INTO ?').run(databaseBackup);
  const backupPaths = [databaseBackup];
  const playlists = join(dirname(path), 'masterPlaylists6.xml');
  if (await fileExists(playlists)) {
    const destination = join(directory, basename(playlists));
    await copyFile(playlists, destination);
    backupPaths.push(destination);
  }
  await assertRekordboxClosed();
  return backupPaths;
};
