import { FolderOpen, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import {
  useLiveCompanyState,
  useRefreshStorage,
  useStorageFolder,
  type StorageFolderEntryDTO,
} from '../../../../api/hooks';
import { storageFolderUrl } from '../../../../api/storageLink';
import { EmptyState } from '../../../../components/EmptyState/EmptyState';
import { RoundIconButton } from '../../../../components/RoundIconButton/RoundIconButton';
import { FolderTree } from '../../../../components/StorageBrowser/FolderTree';
import { StorageBrowserDialog } from '../../../../components/StorageBrowser/StorageBrowserDialog';
import { getRuntimeConfig } from '../../../../runtime-config';
import { t } from '../../../../strings';
import { TrayPanel } from './TrayPanel';

export interface ResourcesDetailsProps {
  readonly companyId: string;
  readonly headingId: string;
  /** Where dialogs, menus and tooltips open, to stay inside full screen. */
  readonly portalContainer?: Element | undefined;
}

/** The company's resources folder, relative to its storage. */
const RESOURCES = 'resources/';

/** What the storage browser dialog is showing: one folder, or all resources. */
type Browsing =
  | { readonly kind: 'folder'; readonly folder: StorageFolderEntryDTO }
  | { readonly kind: 'all' };

/**
 * The plan chest's tray (002.08): the company's resource folders as a tree,
 * each with its purpose. A click or Enter on a folder opens the storage
 * browser there; "Browse all" opens it at `resources/`, whose own files the
 * folders-only tree leaves out. Only live resources show: task drafts live
 * under the task folders until their task succeeds.
 *
 * Storage has no live updates (002.05), so the listing is fetched when the
 * tray opens, and a refresh action fetches it again. Closing the dialog
 * returns focus to the row or button that opened it (ADR-027).
 */
export const ResourcesDetails = ({
  companyId,
  headingId,
  portalContainer,
}: ResourcesDetailsProps) => {
  const listing = useStorageFolder(companyId, RESOURCES);
  const company = useLiveCompanyState(companyId).data ?? undefined;
  const refresh = useRefreshStorage();
  const [browsing, setBrowsing] = useState<Browsing | null>(null);
  const heading = t('visualisation.resources.heading');

  const consoleUrl =
    company === undefined
      ? null
      : storageFolderUrl(getRuntimeConfig(), `${company.slug}/${RESOURCES}`);

  const body = listing.isPending ? (
    <p>{t('visualisation.tray.loading')}</p>
  ) : listing.isError ? (
    <p>{t('storage.error')}</p>
  ) : listing.data.folders.length === 0 ? (
    <EmptyState
      heading={t('visualisation.resources.empty.heading')}
      headingLevel={3}
    >
      {t('visualisation.resources.empty.body')}
    </EmptyState>
  ) : (
    <FolderTree
      companyId={companyId}
      root={RESOURCES}
      label={heading}
      foldersOnly
      onOpen={(folder) => {
        setBrowsing({ kind: 'folder', folder });
      }}
    />
  );

  return (
    <TrayPanel
      headingId={headingId}
      heading={heading}
      actions={
        <>
          <RoundIconButton
            icon={FolderOpen}
            label={t('visualisation.resources.browseAll')}
            portalContainer={portalContainer}
            onPress={() => {
              setBrowsing({ kind: 'all' });
            }}
          />
          <RoundIconButton
            icon={RefreshCw}
            label={t('visualisation.resources.refresh')}
            portalContainer={portalContainer}
            onPress={() => void refresh()}
          />
        </>
      }
      description={
        <p>
          {t('visualisation.resources.description')}{' '}
          {consoleUrl !== null && (
            // Visible text first, then a hidden suffix, as the bookshelf's
            // links do (WCAG 2.5.3, ADR-027).
            <a href={consoleUrl} target="_blank" rel="noopener noreferrer">
              {t('visualisation.resources.consoleLink')}{' '}
              <span className="visually-hidden">
                {t('visualisation.resources.consoleLinkSuffix')}
              </span>
            </a>
          )}
        </p>
      }
    >
      {body}
      {browsing !== null && (
        <StorageBrowserDialog
          companyId={companyId}
          root={browsing.kind === 'all' ? RESOURCES : browsing.folder.path}
          heading={browsing.kind === 'all' ? heading : browsing.folder.name}
          description={
            browsing.kind === 'folder'
              ? (browsing.folder.purpose ?? undefined)
              : undefined
          }
          onClose={() => {
            setBrowsing(null);
          }}
          portalContainer={portalContainer}
        />
      )}
    </TrayPanel>
  );
};
