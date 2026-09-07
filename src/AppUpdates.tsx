import { useEffect, useState, type JSX } from 'react';

import type { UpdateStatus } from './shared/app-updates';

const messageFor = (status: UpdateStatus): string => {
  switch (status.kind) {
    case 'disabled':
    case 'error':
      return status.message;
    case 'idle':
      return `Arsenal ${status.currentVersion}`;
    case 'checking':
      return 'Checking for updates...';
    case 'unpublished':
      return 'No releases have been published yet.';
    case 'current':
      return `Arsenal ${status.currentVersion} is up to date.`;
    case 'available':
      return `Arsenal ${status.version} is available.`;
    case 'downloading':
      return `Downloading ${status.version}: ${status.percent}%`;
    case 'downloaded':
      return `Arsenal ${status.version} is ready to install.`;
  }
};

export const AppUpdates = (): JSX.Element => {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [requestFailed, setRequestFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let receivedChange = false;
    const unsubscribe = window.appUpdates.onChange((nextStatus) => {
      receivedChange = true;
      setStatus(nextStatus);
      setRequestFailed(false);
    });
    void window.appUpdates.status().then((initialStatus) => {
      if (active && !receivedChange) {
        setStatus(initialStatus);
      }
    }).catch(() => {
      if (active) {
        setRequestFailed(true);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const performAction = async (): Promise<void> => {
    setRequestFailed(false);
    try {
      if (status?.kind === 'available') {
        await window.appUpdates.download();
      } else if (status?.kind === 'downloaded') {
        await window.appUpdates.install();
      } else {
        await window.appUpdates.check();
      }
    } catch {
      setRequestFailed(true);
    }
  };

  const label = status?.kind === 'checking'
    ? 'Checking...'
    : status?.kind === 'downloading'
      ? `Downloading ${status.percent}%`
      : status?.kind === 'available'
        ? 'Download update'
        : status?.kind === 'downloaded'
          ? 'Install and restart'
          : status?.kind === 'error' || requestFailed
            ? 'Retry update check'
            : 'Check for updates';
  const message = requestFailed
    ? status?.kind === 'downloaded' ? 'Could not restart Arsenal. Wait for library actions to finish, then try again.' : 'Could not update Arsenal. Try again.'
    : status === null ? 'App updates' : messageFor(status);

  return (
    <div className="app-updates">
      <p role="status" title={message}>{message}</p>
      <button
        type="button"
        onClick={() => void performAction()}
        disabled={status?.kind === 'disabled' || status?.kind === 'checking' || status?.kind === 'downloading'}
        title={message}
      >
        {label}
      </button>
    </div>
  );
};
