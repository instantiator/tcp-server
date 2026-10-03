import {
  useLiveCompanyState,
  useLiveCompanyTasksList,
} from '../../../../api/hooks';
import type { TaskDTO } from '../../../../api/dtos';
import type { ReactNode } from 'react';
import { taskOutputsUrl } from '../../../../api/storageLink';
import { shortened } from '../../../../components/ExpandableText/excerpt';
import { getRuntimeConfig } from '../../../../runtime-config';
import { t } from '../../../../strings';
import { TrayHeading } from './TrayHeading';

export interface ArchiveDetailsProps {
  readonly companyId: string;
  readonly headingId: string;
  /** The follow toggle, shown beside this panel's own heading. */
  readonly headingAction?: ReactNode;
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
  headingAction,
}: ArchiveDetailsProps) => {
  const tasksQuery = useLiveCompanyTasksList(companyId);
  const companyQuery = useLiveCompanyState(companyId);

  if (tasksQuery.isPending || companyQuery.isPending) {
    return (
      <>
        <TrayHeading id={headingId} action={headingAction}>
          {t('visualisation.archive.heading')}
        </TrayHeading>
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
        <TrayHeading id={headingId} action={headingAction}>
          {t('visualisation.archive.heading')}
        </TrayHeading>
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
      <TrayHeading id={headingId} action={headingAction}>
        {t('visualisation.archive.heading')}
      </TrayHeading>
      {!configured && <p>{t('visualisation.archive.unconfigured')}</p>}
      {succeeded.length === 0 ? (
        <p>{t('visualisation.archive.empty')}</p>
      ) : (
        <ul aria-label={t('visualisation.archive.heading')}>
          {succeeded.map((task) => {
            const url = taskOutputsUrl(config, company.slug, task.id);
            const row = t('visualisation.archive.row', {
              shortcode: task.shortcode,
              request: shortened(task.request),
            });
            return (
              <li key={task.id}>
                {url === null ? (
                  row
                ) : (
                  // The visible row leads the accessible name, and a hidden
                  // suffix says where it goes. An `aria-label` would replace
                  // the row instead, so a speech-input user saying what they
                  // see would miss (WCAG 2.5.3). The shortcode keeps each
                  // name unique (2.4.4); the suffix warns of the new tab.
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    {row}{' '}
                    <span className="visually-hidden">
                      {t('visualisation.archive.linkSuffix')}
                    </span>
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
