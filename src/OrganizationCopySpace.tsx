import type { JSX } from 'react';
import type { LibraryOrganizationPreview } from './shared/dj-library';
import './ReorganizeLibraryPage.css';

type CopySpace = LibraryOrganizationPreview['copySpace'];

export const insufficientCopySpace = (space: CopySpace | undefined): boolean =>
  space !== null && space !== undefined && space.availableBytes !== null && space.requiredBytes > space.availableBytes;

const formatSpace = (bytes: number): string => {
  const unit = Math.min(4, Math.max(0, Math.floor(Math.log2(Math.max(1, bytes)) / 10)));
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(bytes / 1024 ** unit)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`;
};

export const OrganizationCopySpace = ({ space }: Readonly<{ space: NonNullable<CopySpace> }>): JSX.Element =>
  <div className="organization-space" aria-live="polite">
    <p><strong>Estimated space needed: {formatSpace(space.requiredBytes)}</strong><br />
      {space.availableBytes === null ? 'Free space could not be checked.' : `Available when previewed: ${formatSpace(space.availableBytes)}`}</p>
    {insufficientCopySpace(space) ? <p className="reorganize-error" role="alert">Not enough free space. Choose another destination or free up at least {formatSpace(space.requiredBytes - (space.availableBytes ?? 0))}, then preview again.</p>
      : <p>{space.availableBytes === null ? 'Check the destination has enough room before copying.' : 'Free space is checked again before copying. Folder and filesystem overhead may vary.'}</p>}
  </div>;
