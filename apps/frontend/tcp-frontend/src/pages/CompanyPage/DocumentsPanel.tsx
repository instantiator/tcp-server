import { RefreshCw } from 'lucide-react';
import { useLiveCompanyTasksList } from '../../api/hooks';
import type { TaskDTO } from '../../api/dtos';
import { storageFolderUrl } from '../../api/storageLink';
import { ErrorState } from '../../components/ErrorState/ErrorState';
import { LoadingState } from '../../components/LoadingState/LoadingState';
import { RoundIconButton } from '../../components/RoundIconButton/RoundIconButton';
import { getRuntimeConfig } from '../../runtime-config';
import { t } from '../../strings';

export interface DocumentsPanelProps {
  readonly companyId: string;
  readonly companySlug: string;
}

/** Newest first, by `updatedAt`, as the archive orders them. */
const byUpdatedAtDescending = (a: TaskDTO, b: TaskDTO): number =>
  new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();

/**
 * Data → Documents (002.00): links into the document store's own browser
 * (Silo) for the company's root folder, its resources and each succeeded
 * task's outputs. The app has no file browser of its own yet, so these hand
 * off to the store's console in a new tab, as the office view's archive
 * does. Without the console configured there is nothing to link to, and it
 * says so.
 *
 * Refresh refetches the tasks: a task that has just succeeded adds a row.
 */
export const DocumentsPanel = ({
  companyId,
  companySlug,
}: DocumentsPanelProps) => {
  const tasks = useLiveCompanyTasksList(companyId);
  const config = getRuntimeConfig();

  const folders = [
    { label: t('documents.root'), prefix: `${companySlug}/` },
    { label: t('documents.resources'), prefix: `${companySlug}/resources/` },
    ...(tasks.data ?? [])
      .filter((task) => task.status === 'succeeded')
      .sort(byUpdatedAtDescending)
      .map((task) => ({
        label: t('documents.taskOutputs', {
          shortcode: task.shortcode,
          request: task.request,
        }),
        prefix: `${companySlug}/tasks/${task.id}/completed/`,
      })),
  ];

  return (
    <section aria-labelledby="documents-heading">
      <h2 id="documents-heading">{t('documents.heading')}</h2>
      {storageFolderUrl(config, `${companySlug}/`) === null ? (
        <p>{t('documents.unconfigured')}</p>
      ) : (
        <>
          <p>{t('documents.intro')}</p>
          <RoundIconButton
            icon={RefreshCw}
            label={t('documents.refresh')}
            isPending={tasks.isFetching}
            onPress={() => void tasks.refetch()}
          />
          <table className="tcp-table" aria-labelledby="documents-heading">
            <thead>
              <tr>
                <th scope="col">{t('documents.column.folder')}</th>
                <th scope="col">{t('documents.column.location')}</th>
              </tr>
            </thead>
            <tbody>
              {folders.map(({ label, prefix }) => (
                <tr key={prefix}>
                  <th scope="row">
                    <a
                      href={storageFolderUrl(config, prefix) ?? undefined}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {label}{' '}
                      <span className="visually-hidden">
                        {t('documents.linkSuffix')}
                      </span>
                    </a>
                  </th>
                  <td>{prefix}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {tasks.isPending && <LoadingState label={t('documents.loading')} />}
          {tasks.isError && (
            <ErrorState
              message={t('documents.error')}
              channel="documents"
              onRetry={() => void tasks.refetch()}
            />
          )}
        </>
      )}
    </section>
  );
};
