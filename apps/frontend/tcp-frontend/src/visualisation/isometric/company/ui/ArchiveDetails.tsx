import {
  useLiveCompanyState,
  useLiveCompanyTasksList,
} from '../../../../api/hooks';
import type { TaskDTO } from '../../../../api/dtos';
import { taskOutputsUrl } from '../../../../api/storageLink';
import { excerptOf } from '../../../../components/ExpandableText/excerpt';
import { getRuntimeConfig } from '../../../../runtime-config';
import { t } from '../../../../strings';

export interface ArchiveDetailsProps {
  readonly companyId: string;
  readonly headingId: string;
}

/** Newest first, by `updatedAt`. */
const byUpdatedAtDescending = (a: TaskDTO, b: TaskDTO): number =>
  new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();

/**
 * The archive bookshelf's live details in the office tray: the company's
 * completed tasks, newest first, each linking out to its outputs folder in
 * Silo.
 *
 * The company is fetched only for its `slug` — `taskOutputsUrl` needs it to
 * build the storage key, the same prefix `taskCompletedPrefix` builds
 * server-side. Without `storageConsoleUrl`/`storageBucket` configured
 * (`runtime-config.ts`), rows still list but carry no link — a plain-text
 * fallback rather than a broken one, with a note explaining why.
 */
export const ArchiveDetails = ({
  companyId,
  headingId,
}: ArchiveDetailsProps) => {
  const tasksQuery = useLiveCompanyTasksList(companyId);
  const companyQuery = useLiveCompanyState(companyId);

  if (tasksQuery.isPending || companyQuery.isPending) {
    return (
      <>
        <h2 id={headingId}>{t('visualisation.archive.heading')}</h2>
        <p>{t('visualisation.tray.loading')}</p>
      </>
    );
  }

  // `GET /api/company/{id}` answers 200 with a JSON `null` for a company the
  // caller cannot see (documented on `useLiveCompanyState`), which reads the
  // same as "gone" here as it does everywhere else this hook is used.
  const company = companyQuery.data ?? undefined;
  if (tasksQuery.isError || companyQuery.isError || company === undefined) {
    return (
      <>
        <h2 id={headingId}>{t('visualisation.archive.heading')}</h2>
        <p>{t('visualisation.tray.gone')}</p>
      </>
    );
  }

  const succeeded = (tasksQuery.data ?? [])
    .filter((task) => task.status === 'succeeded')
    .sort(byUpdatedAtDescending);

  const config = getRuntimeConfig();
  const configured =
    config.storageConsoleUrl !== undefined &&
    config.storageBucket !== undefined;

  return (
    <>
      <h2 id={headingId}>{t('visualisation.archive.heading')}</h2>
      {!configured && <p>{t('visualisation.archive.unconfigured')}</p>}
      {succeeded.length === 0 ? (
        <p>{t('visualisation.archive.empty')}</p>
      ) : (
        <ul aria-label={t('visualisation.archive.heading')}>
          {succeeded.map((task) => {
            const url = taskOutputsUrl(config, company.slug, task.id);
            const row = t('visualisation.archive.row', {
              shortcode: task.shortcode,
              excerpt: excerptOf(task.request),
            });
            return (
              <li key={task.id}>
                {url === null ? (
                  row
                ) : (
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t('visualisation.archive.open', {
                      shortcode: task.shortcode,
                    })}
                  >
                    {row}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
};
