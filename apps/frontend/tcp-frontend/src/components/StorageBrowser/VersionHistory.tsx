import { Download, RotateCcw } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  downloadStorageFile,
  useRestoreStorageVersion,
  useStorageVersions,
  type StorageFileEntryDTO,
  type StorageVersionDTO,
} from '../../api/hooks';
import { ApiError } from '../../api/errors';
import { ANNOUNCE_IMMEDIATE_MS, announce } from '../../announce/announcer';
import { t } from '../../strings';
import { ConfirmDialog } from '../Dialog/ConfirmDialog';
import { ErrorState } from '../ErrorState/ErrorState';
import { LoadingState } from '../LoadingState/LoadingState';
import { RoundIconButton } from '../RoundIconButton/RoundIconButton';
import { formatSize, savedAt } from './format';
import { STORAGE_CHANNEL } from './useUploads';

/**
 * A file's kept versions, behind a native disclosure so nothing is fetched
 * until it is opened. An older version can be downloaded, or restored: the
 * old content is copied over the current one as a new version, after a
 * confirmation. Focus goes back to the disclosure's summary afterwards, the
 * stable element nearest to the row that just changed (ADR-027).
 */
export const VersionHistory = ({
  companyId,
  file,
  portalContainer,
}: {
  readonly companyId: string;
  readonly file: StorageFileEntryDTO;
  readonly portalContainer?: Element | undefined;
}) => {
  const [open, setOpen] = useState(false);
  const [restoring, setRestoring] = useState<StorageVersionDTO | null>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const versions = useStorageVersions(companyId, file.path, { enabled: open });
  const restore = useRestoreStorageVersion(companyId);

  const confirmRestore = (version: StorageVersionDTO) => {
    setRestoring(null);
    const date = savedAt(version.lastModified);
    restore.mutate(
      { path: file.path, versionId: version.versionId },
      {
        onSuccess: () =>
          announce({
            channel: STORAGE_CHANNEL,
            change: 'storage.restored',
            params: { name: file.name, date },
            throttleMs: ANNOUNCE_IMMEDIATE_MS,
          }),
        onError: (error) =>
          announce({
            channel: STORAGE_CHANNEL,
            change: 'storage.restoreFailed',
            params: {
              reason:
                error instanceof ApiError
                  ? error.message
                  : t('records.error.generic'),
            },
            politeness: 'assertive',
          }),
        onSettled: () => summaryRef.current?.focus(),
      },
    );
  };

  return (
    <details
      className="storage-browser__history"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary ref={summaryRef}>{t('storage.history')}</summary>
      {versions.isPending && open && (
        <LoadingState label={t('storage.history.loading')} />
      )}
      {versions.isError && (
        <ErrorState
          message={t('storage.history.error')}
          channel={STORAGE_CHANNEL}
          onRetry={() => void versions.refetch()}
        />
      )}
      {versions.data !== undefined && (
        <table className="tcp-table">
          <caption className="visually-hidden">
            {t('storage.history')}: {file.name}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t('storage.history.saved')}</th>
              <th scope="col">{t('storage.history.size')}</th>
              <th scope="col">
                <span className="visually-hidden">
                  {t('storage.history.actions')}
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {versions.data.map((version) => {
              const date = savedAt(version.lastModified);
              return (
                <tr key={version.versionId}>
                  <th scope="row">
                    {version.isLatest
                      ? t('storage.history.current', { date })
                      : date}
                  </th>
                  <td>{formatSize(version.size)}</td>
                  <td>
                    <RoundIconButton
                      icon={Download}
                      outline
                      label={t('storage.history.download', { date })}
                      portalContainer={portalContainer}
                      onPress={() =>
                        void downloadStorageFile(
                          companyId,
                          file.path,
                          version.versionId,
                        ).catch(() =>
                          announce({
                            channel: STORAGE_CHANNEL,
                            change: 'storage.downloadFailed',
                            politeness: 'assertive',
                          }),
                        )
                      }
                    />
                    {!version.isLatest && (
                      <RoundIconButton
                        icon={RotateCcw}
                        label={t('storage.history.restore', { date })}
                        isPending={
                          restore.isPending &&
                          restore.variables.versionId === version.versionId
                        }
                        portalContainer={portalContainer}
                        onPress={() => setRestoring(version)}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <ConfirmDialog
        isOpen={restoring !== null}
        heading={t('storage.restore.heading')}
        message={t('storage.restore.message', {
          name: file.name,
          date: restoring === null ? '' : savedAt(restoring.lastModified),
        })}
        confirmLabel={t('storage.restore.confirm')}
        cancelLabel={t('confirm.no')}
        portalContainer={portalContainer}
        onConfirm={() => restoring !== null && confirmRestore(restoring)}
        onCancel={() => setRestoring(null)}
      />
    </details>
  );
};
