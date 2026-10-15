import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { LibraryOrganizationDestination } from '../shared/dj-library';

const run = promisify(execFile);
const options = { timeout: 10000, maxBuffer: 4 * 1024 * 1024, windowsHide: true };

export const organizationDestination = async (root: string): Promise<LibraryOrganizationDestination> => {
  try {
    let path = resolve(root);
    for (;;) {
      try {
        if (!(await stat(path)).isDirectory()) return 'unknown';
        path = await realpath(path);
        break;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT') || dirname(path) === path) throw error;
        path = dirname(path);
      }
    }
    if (process.platform === 'darwin') {
      const { stdout } = await run('/usr/sbin/diskutil', ['info', '-plist', path], options);
      if (/<key>Internal<\/key>\s*<false\s*\/>/.test(stdout) || /<key>RemovableMedia<\/key>\s*<true\s*\/>/.test(stdout)) return 'external';
      return /<key>Internal<\/key>\s*<true\s*\/>/.test(stdout) ? 'internal' : 'unknown';
    }
    if (process.platform === 'win32') {
      const script = `$ErrorActionPreference='Stop'; $v=Get-Volume -FilePath '${path.replaceAll("'", "''")}';
        $d=@($v | Get-Partition | Get-Disk);
        if ($v.DriveType -eq 'Removable') {'external'}
        elseif ($d.Count -ne 1) {'unknown'}
        elseif ([string]$d[0].BusType -in @('USB','SD','MMC','1394')) {'external'}
        elseif ([string]$d[0].BusType -in @('SATA','SAS','NVMe','ATA','SCM')) {'internal'}
        else {'unknown'}`;
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], options);
      const kind = stdout.trim();
      return kind === 'internal' || kind === 'external' ? kind : 'unknown';
    }
    if (process.platform === 'linux') {
      const [{ stdout: device }, { stdout }] = await Promise.all([
        run('findmnt', ['--noheadings', '--target', path, '--output', 'SOURCE', '--nofsroot', '--evaluate'], options),
        run('lsblk', ['--json', '--tree', '--paths', '--output', 'NAME,RM,HOTPLUG'], options),
      ]);
      const data: unknown = JSON.parse(stdout);
      if (typeof data !== 'object' || data === null || !('blockdevices' in data) || !Array.isArray(data.blockdevices)) return 'unknown';
      const matches: LibraryOrganizationDestination[] = [];
      const visit = (node: unknown, external = false): void => {
        if (typeof node !== 'object' || node === null) return;
        const removable = 'rm' in node ? node.rm : null;
        const hotplug = 'hotplug' in node ? node.hotplug : null;
        external ||= removable === true || removable === 1 || hotplug === true || hotplug === 1;
        if ('name' in node && node.name === device.trim()) {
          matches.push(external ? 'external' : (removable === false || removable === 0) && (hotplug === false || hotplug === 0) ? 'internal' : 'unknown');
        }
        if ('children' in node && Array.isArray(node.children)) for (const child of node.children) visit(child, external);
      };
      for (const node of data.blockdevices) visit(node);
      return matches.includes('external') ? 'external' : matches.length && matches.every((kind) => kind === 'internal') ? 'internal' : 'unknown';
    }
  } catch { /* Unverified destinations cannot replace the active library. */ }
  return 'unknown';
};
