import {
  ChevronRight,
  Download,
  FileText,
  Folder,
  FolderUp,
  Lock,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { createContext, useContext, useId, useRef, useState } from 'react';
import {
  Button,
  DropZone,
  FileTrigger,
  Text,
  Toolbar,
  Tree,
  TreeItem,
  TreeItemContent,
  type Key,
} from 'react-aria-components';
import {
  downloadStorageFile,
  downloadStorageZip,
  useDeleteStorage,
  useRefreshStorage,
  useStorageFolder,
  type StorageFileEntryDTO,
  type StorageFolderEntryDTO,
} from '../../api/hooks';
import { ApiError } from '../../api/errors';
import { ANNOUNCE_IMMEDIATE_MS, announce } from '../../announce/announcer';
import { t, tCount } from '../../strings';
import { ConfirmDialog } from '../Dialog/ConfirmDialog';
import { EmptyState } from '../EmptyState/EmptyState';
import { ErrorState } from '../ErrorState/ErrorState';
import { Icon } from '../Icon/Icon';
import { LoadingState } from '../LoadingState/LoadingState';
import { RoundIconButton } from '../RoundIconButton/RoundIconButton';
import { FilePreview } from './FilePreview';
import { formatSize, savedAt } from './format';
import { isWritablePath, parentOf } from './paths';
import {
  STORAGE_CHANNEL,
  itemsFromDrop,
  itemsFromFiles,
  useUploads,
} from './useUploads';
import { VersionHistory } from './VersionHistory';
import './StorageBrowser.css';

export interface StorageBrowserProps {
  readonly companyId: string;
  /** The folder the browser starts at and never goes above: `''` or a path ending in `/`. */
  readonly root: string;
  /** The tree's accessible name. Already resolved through `t`. */
  readonly label: string;
  /** A friendlier name for a folder (a task's folder by its shortcode), or `undefined` for its own. */
  readonly folderLabel?: (path: string) => string | undefined;
  /** Where dialogs and tooltips portal, inside the office view's full screen. */
  readonly portalContainer?: Element | undefined;
}

/** What every row needs, without threading it through React Aria's collection. */
interface BrowserContextValue {
  readonly companyId: string;
  readonly expanded: ReadonlySet<Key>;
  readonly folderLabel?: (path: string) => string | undefined;
}

const BrowserContext = createContext<BrowserContextValue | null>(null);

const useBrowser = (): BrowserContextValue => {
  const value = useContext(BrowserContext);
  if (value === null) throw new Error('A storage row outside StorageBrowser');
  return value;
};

/** The server's own words for a refusal, or a generic line. */
const reasonOf = (error: unknown): string =>
  error instanceof ApiError ? error.message : t('records.error.generic');

/** Says what the user's own action did, straight away. */
const say = (
  change: Parameters<typeof announce>[0]['change'],
  params?: Parameters<typeof announce>[0]['params'],
) =>
  announce({
    channel: STORAGE_CHANNEL,
    change,
    params,
    throttleMs: ANNOUNCE_IMMEDIATE_MS,
  });

/** Says a request failed, interrupting: the user is waiting on it. */
const sayFailed = (
  change: Parameters<typeof announce>[0]['change'],
  params?: Parameters<typeof announce>[0]['params'],
) =>
  announce({
    channel: STORAGE_CHANNEL,
    change,
    params,
    politeness: 'assertive',
  });

/**
 * One folder's subfolders, then its files, as tree rows. It is rendered only
 * while its folder is expanded, so a folder's listing is fetched on demand.
 */
const FolderContents = ({ path }: { readonly path: string }) => {
  const { companyId } = useBrowser();
  const listing = useStorageFolder(companyId, path);
  if (listing.data === undefined) {
    const text = listing.isError ? t('storage.error') : t('storage.loading');
    return (
      <TreeItem id={`${path}\u0000status`} textValue={text} isDisabled>
        <TreeItemContent>
          <span className="storage-browser__status">{text}</span>
        </TreeItemContent>
      </TreeItem>
    );
  }
  return (
    <>
      {listing.data.folders.map((entry) => (
        <FolderItem key={entry.path} entry={entry} />
      ))}
      {listing.data.files.map((entry) => (
        <FileItem key={entry.path} entry={entry} />
      ))}
    </>
  );
};

/**
 * A folder row: expand with its chevron or the arrow keys; select with a
 * click or Space. Top-level folders that can't be changed carry a lock.
 */
const FolderItem = ({ entry }: { readonly entry: StorageFolderEntryDTO }) => {
  const { expanded, folderLabel } = useBrowser();
  const name = folderLabel?.(entry.path) ?? entry.name;
  return (
    <TreeItem
      id={entry.path}
      textValue={name}
      hasChildItems
      className="react-aria-TreeItem storage-browser__row"
    >
      <TreeItemContent>
        {({ level }) => (
          <>
            <Button slot="chevron" className="storage-browser__chevron">
              <Icon icon={ChevronRight} />
            </Button>
            <Icon icon={Folder} />
            <span className="storage-browser__name">{name}</span>
            {level === 1 && !isWritablePath(entry.path) && (
              <span className="storage-browser__lock">
                <Icon icon={Lock} />
                <span className="visually-hidden">{t('storage.readOnly')}</span>
              </span>
            )}
            {entry.purpose !== null && (
              <span className="storage-browser__purpose">{entry.purpose}</span>
            )}
          </>
        )}
      </TreeItemContent>
      {expanded.has(entry.path) && <FolderContents path={entry.path} />}
    </TreeItem>
  );
};

/** A file row, with its size. */
const FileItem = ({ entry }: { readonly entry: StorageFileEntryDTO }) => (
  <TreeItem
    id={entry.path}
    textValue={entry.name}
    className="react-aria-TreeItem storage-browser__row"
  >
    <TreeItemContent>
      <span className="storage-browser__chevron" />
      <Icon icon={FileText} />
      <span className="storage-browser__name">{entry.name}</span>
      <span className="storage-browser__size">{formatSize(entry.size)}</span>
    </TreeItemContent>
  </TreeItem>
);

/**
 * The storage browser (002.05): a company's shared storage as a tree rooted
 * at `root`, with a preview of the one file selected. It works in a page's
 * main area, a tab or a dialog: below 720px wide the preview stacks under
 * the tree (a container query, so the host needs no prop).
 *
 * Uploads go into the selected folder, or the folder of the selected file,
 * or the root. Only `resources/` takes uploads and deletes; the server
 * refuses the rest, and a browser rooted elsewhere shows no upload or delete
 * controls at all. Old versions can be seen and restored for resources.
 *
 * Focus (ADR-027): selecting moves no focus; dialogs return focus to their
 * trigger; a delete returns focus to the tree, since the rows it removed may
 * have held it. Results are announced on the `storage` channel.
 */
export const StorageBrowser = ({
  companyId,
  root,
  label,
  folderLabel,
  portalContainer,
}: StorageBrowserProps) => {
  const [expanded, setExpanded] = useState<ReadonlySet<Key>>(new Set());
  const [selected, setSelected] = useState<ReadonlySet<Key>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const treeRef = useRef<HTMLDivElement>(null);
  const previewId = useId();

  const rootListing = useStorageFolder(companyId, root);
  const refresh = useRefreshStorage();
  const uploads = useUploads(companyId);
  const remove = useDeleteStorage(companyId);

  const paths = [...selected].map(String);
  const single = paths.length === 1 ? paths[0] : undefined;
  const previewPath =
    single !== undefined && !single.endsWith('/') ? single : undefined;
  const previewFolder = useStorageFolder(
    companyId,
    parentOf(previewPath ?? root),
    { enabled: previewPath !== undefined },
  );
  const previewEntry = previewFolder.data?.files.find(
    (f) => f.path === previewPath,
  );

  const target =
    single === undefined
      ? root
      : single.endsWith('/')
        ? single
        : parentOf(single);
  const targetName = target === '' ? t('storage.rootName') : target;
  const canUpload = isWritablePath(target);
  // A browser rooted outside resources/ (a task's folder) can never change
  // anything, so it shows no write controls rather than disabled ones.
  const writableSomewhere = root === '' || isWritablePath(root);
  const canDelete =
    paths.length > 0 &&
    paths.every((p) => isWritablePath(p) && p !== 'resources/');

  const zipName = `${root.replace(/\/$/, '').split('/').pop() || 'files'}.zip`;
  const download = () =>
    void (
      previewPath !== undefined
        ? downloadStorageFile(companyId, previewPath)
        : downloadStorageZip(
            companyId,
            root,
            paths.length > 0 ? paths : [root],
            zipName,
          )
    ).catch(() => sayFailed('storage.downloadFailed'));

  const deleteSelected = async () => {
    setConfirmDelete(false);
    const items = tCount('storage.itemCount', paths.length);
    try {
      for (const path of paths) await remove.mutateAsync(path);
      say('storage.deleted', { items });
    } catch (error) {
      sayFailed('storage.deleteFailed', { reason: reasonOf(error) });
    }
    setSelected(new Set());
    treeRef.current?.focus();
  };

  const tree = rootListing.isPending ? (
    <LoadingState label={t('storage.loading')} />
  ) : rootListing.isError ? (
    <ErrorState
      message={t('storage.error')}
      channel={STORAGE_CHANNEL}
      onRetry={() => void rootListing.refetch()}
    />
  ) : rootListing.data.folders.length === 0 &&
    rootListing.data.files.length === 0 ? (
    <EmptyState heading={t('storage.empty.heading')} headingLevel={3}>
      {t('storage.empty.body')}
    </EmptyState>
  ) : (
    <Tree
      ref={treeRef}
      aria-label={label}
      className="react-aria-Tree storage-browser__tree"
      selectionMode="multiple"
      selectedKeys={selected}
      onSelectionChange={(keys) => {
        // Select-all would pick every row of every open folder; ignore it.
        if (keys !== 'all') setSelected(new Set(keys));
      }}
      expandedKeys={expanded}
      onExpandedChange={(keys) => setExpanded(new Set(keys))}
    >
      <FolderContents path={root} />
    </Tree>
  );

  return (
    <BrowserContext.Provider value={{ companyId, expanded, folderLabel }}>
      <div className="storage-browser">
        <Toolbar
          aria-label={t('storage.toolbar')}
          className="react-aria-Toolbar storage-browser__toolbar"
        >
          {writableSomewhere && (
            <>
              <FileTrigger
                allowsMultiple
                onSelect={(files) =>
                  files !== null &&
                  void uploads.start(itemsFromFiles(files, target), targetName)
                }
              >
                <Button
                  className="react-aria-Button tcp-button--outline"
                  isDisabled={!canUpload}
                  isPending={uploads.busy}
                >
                  <Icon icon={Upload} /> {t('storage.uploadFiles')}
                </Button>
              </FileTrigger>
              <FileTrigger
                acceptDirectory
                onSelect={(files) =>
                  files !== null &&
                  void uploads.start(itemsFromFiles(files, target), targetName)
                }
              >
                <Button
                  className="react-aria-Button tcp-button--outline"
                  isDisabled={!canUpload}
                  isPending={uploads.busy}
                >
                  <Icon icon={FolderUp} /> {t('storage.uploadFolder')}
                </Button>
              </FileTrigger>
            </>
          )}
          <Button
            className="react-aria-Button tcp-button--outline"
            isDisabled={rootListing.data === undefined}
            onPress={download}
          >
            <Icon icon={Download} />{' '}
            {paths.length === 0
              ? t('storage.downloadAll')
              : t('storage.download')}
          </Button>
          {writableSomewhere && (
            <Button
              className="react-aria-Button tcp-button--outline"
              isDisabled={!canDelete}
              isPending={remove.isPending}
              onPress={() => setConfirmDelete(true)}
            >
              <Icon icon={Trash2} /> {t('storage.delete')}
            </Button>
          )}
          <RoundIconButton
            icon={RefreshCw}
            outline
            label={t('storage.refresh')}
            portalContainer={portalContainer}
            onPress={refresh}
          />
          {paths.length > 0 && (
            <span className="storage-browser__count">
              {tCount('storage.selected', paths.length)}
            </span>
          )}
        </Toolbar>
        <p className="storage-browser__target">
          {!writableSomewhere
            ? t('storage.readOnlyHere')
            : canUpload
              ? t('storage.target', { folder: targetName })
              : t('storage.target.readOnly', { folder: targetName })}
        </p>
        {uploads.failures.length > 0 && (
          <ul className="storage-browser__failures">
            {uploads.failures.map(({ name, reason }) => (
              <li key={name}>
                {t('storage.uploadFailedItem', { name, reason })}
              </li>
            ))}
          </ul>
        )}

        <div className="storage-browser__panes">
          <div className="storage-browser__tree-pane">
            {tree}
            {canUpload && (
              <DropZone
                className="react-aria-DropZone storage-browser__drop"
                getDropOperation={() => 'copy'}
                onDrop={(event) =>
                  void itemsFromDrop(event.items, target).then((items) =>
                    uploads.start(items, targetName),
                  )
                }
              >
                <Text slot="label">
                  {t('storage.dropZone', { folder: targetName })}
                </Text>
              </DropZone>
            )}
          </div>

          {previewEntry !== undefined && (
            <section
              className="storage-browser__preview"
              aria-labelledby={previewId}
            >
              <p id={previewId} className="storage-browser__preview-name">
                {previewEntry.name}
              </p>
              <p className="storage-browser__meta">
                {t('storage.preview.meta', {
                  size: formatSize(previewEntry.size),
                  date: savedAt(previewEntry.lastModified),
                })}
              </p>
              <div className="storage-browser__preview-actions">
                <RoundIconButton
                  icon={Download}
                  outline
                  label={t('storage.preview.download', {
                    name: previewEntry.name,
                  })}
                  portalContainer={portalContainer}
                  onPress={download}
                />
              </div>
              {isWritablePath(previewEntry.path) && (
                <VersionHistory
                  key={previewEntry.path}
                  companyId={companyId}
                  file={previewEntry}
                  portalContainer={portalContainer}
                />
              )}
              <FilePreview companyId={companyId} file={previewEntry} />
            </section>
          )}
        </div>

        <ConfirmDialog
          isOpen={uploads.clashes !== null}
          heading={t('storage.replace.heading', {
            files: tCount(
              'storage.fileCount',
              uploads.clashes?.items.length ?? 0,
            ),
          })}
          message={t('storage.replace.message', {
            names: (uploads.clashes?.items ?? [])
              .map((item) => item.path.split('/').pop())
              .join(', '),
            folder: uploads.clashes?.folder ?? '',
          })}
          confirmLabel={t('storage.replace.confirm')}
          cancelLabel={t('storage.replace.skip')}
          portalContainer={portalContainer}
          onConfirm={() => void uploads.replace()}
          onCancel={uploads.skip}
        />
        <ConfirmDialog
          isOpen={confirmDelete}
          heading={t('storage.delete.heading', {
            items: tCount('storage.itemCount', paths.length),
          })}
          message={t('storage.delete.message')}
          confirmLabel={t('storage.delete')}
          portalContainer={portalContainer}
          onConfirm={() => void deleteSelected()}
          onCancel={() => setConfirmDelete(false)}
        />
      </div>
    </BrowserContext.Provider>
  );
};
