import { useEffect, useRef, useState, type JSX } from 'react';

import type { LayaModelStatus } from './shared/laya-model';

export const useLayaModel = () => {
  const [status, setStatus] = useState<LayaModelStatus>({ kind: 'checking' });
  const revision = useRef(0);

  useEffect(() => {
    const request = ++revision.current;
    const unsubscribe = window.layaModel.onStatus((next) => {
      revision.current += 1;
      setStatus(next);
    });
    void window.layaModel.status().then((next) => {
      if (revision.current === request) setStatus(next);
    }).catch(() => {
      if (revision.current === request) {
        setStatus({ kind: 'failed', message: 'Could not check Laya. Try again.' });
      }
    });
    return () => {
      revision.current += 1;
      unsubscribe();
    };
  }, []);

  const download = async (): Promise<void> => {
    const request = ++revision.current;
    setStatus({ kind: 'checking' });
    try {
      const next = await window.layaModel.download();
      if (revision.current === request) setStatus(next);
    } catch {
      if (revision.current === request) {
        setStatus({ kind: 'failed', message: 'Could not set up Laya. Try again.' });
      }
    }
  };

  const cancelDownload = async (): Promise<void> => {
    const request = revision.current;
    try {
      await window.layaModel.cancelDownload();
    } catch {
      if (revision.current === request) {
        setStatus({ kind: 'failed', message: 'Could not cancel Laya setup. Try again.' });
      }
    }
  };

  return { status, download, cancelDownload };
};

const messageFor = (status: LayaModelStatus): string => {
  switch (status.kind) {
    case 'checking': return 'Checking Laya...';
    case 'ready': return 'Laya is ready. Track suggestions run offline on this computer.';
    case 'missing': return 'Download Laya for offline suggestions. About 810 MiB to download, with one-time setup that needs 2.5 GiB of free space.';
    case 'failed': return status.message;
    case 'downloading': {
      const received = (status.receivedBytes / 1024 ** 3).toFixed(2);
      const total = (status.totalBytes / 1024 ** 3).toFixed(2);
      return `Downloading Laya: ${received} of ${total} GiB. You can keep using Arsenal while it downloads.`;
    }
    case 'converting': return status.completedBytes > 0 && status.totalBytes > 0
      ? `Preparing Laya for offline use... ${Math.min(100, Math.floor(100 * status.completedBytes / status.totalBytes))}%`
      : 'Preparing Laya for offline use...';
  }
};

export const LayaModel = ({ model }: Readonly<{ model: ReturnType<typeof useLayaModel> }>): JSX.Element => {
  const { status, download, cancelDownload } = model;
  return (
    <div className="ai-download">
      <p role={status.kind === 'failed' ? 'alert' : 'status'}>{messageFor(status)}</p>
      {status.kind === 'downloading' ? <>
        <progress max={Math.max(1, status.totalBytes)} value={status.receivedBytes} aria-label="Laya model download" />
        <button className="quiet-button" type="button" onClick={() => void cancelDownload()}>Cancel download</button>
      </> : status.kind === 'converting' ? <>
        <progress max={Math.max(1, status.totalBytes)}
          value={status.completedBytes > 0 && status.totalBytes > 0 ? status.completedBytes : undefined}
          aria-label="Laya model setup" />
        <button className="quiet-button" type="button" onClick={() => void cancelDownload()}>Cancel setup</button>
      </> : (status.kind === 'missing' || status.kind === 'failed') && (
        <button className="quiet-button" type="button" onClick={() => void download()}>
          {status.kind === 'failed' ? 'Retry Laya setup' : 'Download Laya'}
        </button>
      )}
    </div>
  );
};
