import { useLiveCompanyTasksList } from '../../api/hooks';
import { storageFolderUrl } from '../../api/storageLink';
import { StorageBrowser } from '../../components/StorageBrowser/StorageBrowser';
import { getRuntimeConfig } from '../../runtime-config';
import { t } from '../../strings';

export interface DocumentsPanelProps {
  readonly companyId: string;
  readonly companySlug: string;
}

/**
 * Data → Documents: the company's folder in the document store, browsed in
 * place. Task folders are labelled with the task's shortcode and request
 * rather than its id. When the store's own console is configured, one link
 * hands off to it in a new tab; the browser works without it.
 */
export const DocumentsPanel = ({
  companyId,
  companySlug,
}: DocumentsPanelProps) => {
  const tasks = useLiveCompanyTasksList(companyId);
  const consoleUrl = storageFolderUrl(getRuntimeConfig(), `${companySlug}/`);

  const folderLabel = (path: string): string | undefined => {
    const task = tasks.data?.find(
      (candidate) => `tasks/${candidate.id}/` === path,
    );
    return task === undefined
      ? undefined
      : t('documents.taskFolder', {
          shortcode: task.shortcode,
          request: task.request,
        });
  };

  return (
    <section aria-labelledby="documents-heading">
      <h2 id="documents-heading">{t('documents.heading')}</h2>
      {consoleUrl !== null && (
        <p>
          <a href={consoleUrl} target="_blank" rel="noopener noreferrer">
            {t('documents.console')}{' '}
            <span className="visually-hidden">{t('documents.linkSuffix')}</span>
          </a>
        </p>
      )}
      <StorageBrowser
        companyId={companyId}
        root=""
        label={t('documents.heading')}
        folderLabel={folderLabel}
      />
    </section>
  );
};
