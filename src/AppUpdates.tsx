import { useEffect, useRef, useState, type JSX } from 'react';

import type { UpdateStatus } from './shared/app-updates';

const messageFor = (status: UpdateStatus): string => {
  switch (status.kind) {
    case 'disabled':
    case 'error':
      return status.message;
    case 'idle':
      return '';
    case 'checking':
      return 'Checking…';
    case 'unpublished':
      return 'No releases have been published yet.';
    case 'current':
      return "You're up to date.";
    case 'available':
      return `Arsenal ${status.version} is available.`;
    case 'downloading':
      return `Downloading ${status.version}: ${status.percent}%`;
    case 'downloaded':
      return `Arsenal ${status.version} is ready to install.`;
  }
};

export const AppUpdates = ({ onError }: Readonly<{
  onError?: (message: string) => void;
}> = {}): JSX.Element => {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [requestFailed, setRequestFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const reportedError = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    let receivedChange = false;
    const unsubscribe = window.appUpdates.onChange((nextStatus) => {
      receivedChange = true;
      setStatus(nextStatus);
      setRequestFailed(false);
      if (nextStatus.kind === 'error' && onError && reportedError.current !== nextStatus.message) {
        reportedError.current = nextStatus.message;
        onError(nextStatus.message);
      }
    });
    void window.appUpdates.status().then((initialStatus) => {
      if (active && !receivedChange) {
        setStatus(initialStatus);
        if (initialStatus.kind === 'error') onError?.(initialStatus.message);
      }
    }).catch(() => {
      if (active) {
        setRequestFailed(true);
        onError?.('Could not load update status.');
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [onError]);

  const performAction = async (): Promise<void> => {
    if (pending || status === null || status.kind === 'disabled' || status.kind === 'checking' || status.kind === 'downloading') return;
    setRequestFailed(false);
    reportedError.current = null;
    setPending(true);
    const optimisticStatus: UpdateStatus = status.kind === 'available'
      ? { kind: 'downloading', version: status.version, percent: 0, currentVersion: status.currentVersion }
      : status.kind === 'downloaded' ? status : { kind: 'checking', currentVersion: status.currentVersion };
    setStatus(optimisticStatus);
    try {
      if (status?.kind === 'available') {
        await window.appUpdates.download();
      } else if (status?.kind === 'downloaded') {
        await window.appUpdates.install();
      } else {
        await window.appUpdates.check();
      }
      if (status.kind === 'downloaded') return;
      const next = await window.appUpdates.status();
      setStatus(next);
      if (next.kind === 'error' && onError && reportedError.current !== next.message) {
        reportedError.current = next.message;
        onError(next.message);
      }
    } catch {
      setStatus((current) => current === optimisticStatus ? status : current);
      setRequestFailed(true);
      onError?.(status.kind === 'downloaded'
        ? 'Could not restart Arsenal. Wait for library actions to finish, then try again.'
        : 'Could not update Arsenal. Try again.');
    } finally {
      setPending(false);
    }
  };

  const label = status?.kind === 'checking'
    ? 'Checking…'
    : status?.kind === 'downloading'
      ? `Downloading ${status.percent}%`
      : status?.kind === 'available'
        ? 'Download update'
        : status?.kind === 'downloaded'
          ? pending ? 'Restarting…' : 'Install and restart'
          : status?.kind === 'error' || requestFailed
            ? 'Retry update check'
            : 'Check for updates';
  const message = requestFailed
    ? status?.kind === 'downloaded' ? 'Could not restart Arsenal. Wait for library actions to finish, then try again.' : 'Could not update Arsenal. Try again.'
    : status === null ? '' : messageFor(status);

  return (
    <div className="app-updates">
      <div className="app-updates-description">
        <strong>{status === null ? 'Arsenal' : `Arsenal ${status.currentVersion}`}</strong>
        {message !== '' && (!onError || !requestFailed && status?.kind !== 'error') &&
          <p role={requestFailed || status?.kind === 'error' ? 'alert' : undefined}>{message}</p>}
      </div>
      <button
        type="button"
        onClick={() => void performAction()}
        disabled={pending || status === null || status.kind === 'disabled' || status.kind === 'checking' || status.kind === 'downloading'}
      >
        {label}
      </button>
    </div>
  );
};
