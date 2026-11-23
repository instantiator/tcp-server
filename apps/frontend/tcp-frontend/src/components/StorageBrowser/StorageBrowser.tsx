import { Download, FolderUp, RefreshCw, Trash2, Upload } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';
import {
  Button,
  DropZone,
  FileTrigger,
  Text,
  Toolbar,
  type Key,
} from 'react-aria-components';
import {
  downloadStorageFile,
  downloadStorageZip,
  useCompanyRolesList,
  useDeleteKnowledge,
  useDeleteStorage,
  useRefreshStorage,
  useStorageFolder,
  type UploadDoor,
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
import { FolderTree } from './FolderTree';
import { formatSize, savedAt } from './format';
import {
  doorFor,
  hasDoorsUnder,
  isWritablePath,
  parentOf,
  storedName,
} from './paths';
import {
  STORAGE_CHANNEL,
  itemsFromDrop,
  itemsFromFiles,
  useUploads,
  type UploadItem,
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

/** An upload into a knowledge or materials door, waiting on its confirmation. */
interface PendingUpload {
  readonly items: readonly UploadItem[];
  readonly door: Exclude<UploadDoor, { kind: 'storage' }>;
  readonly folder: string;
  readonly folderPath: string;
}

/** What the confirmation says before an upload goes through a door. */
const doorQuestion = ({ items, door }: PendingUpload) => {
  const files = tCount('storage.fileCount', items.length);
  if (door.kind === 'materials') {
    return {
      heading: t('storage.door.materials.heading', { files }),
      message: t('storage.door.materials.message'),
    };
  }
  const renames = items
    .filter(({ file }) => storedName(file.name, door) !== file.name)
    .map(({ file }) => `${file.name} → ${storedName(file.name, door)}`);
  const message = t('storage.door.knowledge.message');
  return {
    heading: t('storage.door.knowledge.heading', { files }),
    message:
      renames.length === 0
        ? message
        : `${message} ${t('storage.door.renames', { renames: renames.join(', ') })}`,
  };
};

/** Why a folder takes no uploads, by where it is. */
const readOnlyReason = (folder: string, folderName: string): string =>
  folder.startsWith('knowledge/')
    ? t('storage.door.target.knowledge', { folder: folderName })
    : folder.startsWith('tasks/')
      ? t('storage.door.target.materials', { folder: folderName })
      : t('storage.target.readOnly', { folder: folderName });

/**
 * The storage browser (002.05): a company's shared storage as a tree rooted
 * at `root`, with a preview of the one file selected. It works in a page's
 * main area, a tab or a dialog: below 720px wide the preview stacks under
 * the tree (a container query, so the host needs no prop).
 *
 * Uploads go into the selected folder, or the folder of the selected file,
 * or the root, through that folder's door (002.10, `doorFor`): `resources/`
 * takes files as they are; a knowledge scope and a task's `materials/` take
 * them through their own routes, after one confirmation that says what those
 * routes do. Knowledge files delete through the knowledge route, so their
 * index goes too. Everything else is read-only, and a browser rooted where
 * no door is shows no upload or delete controls at all. Old versions can be
 * seen and restored for resources.
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
  const [selected, setSelected] = useState<ReadonlySet<Key>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, setPending] = useState<PendingUpload | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const previewId = useId();

  const rootListing = useStorageFolder(companyId, root);
  const refresh = useRefreshStorage();
  const uploads = useUploads(companyId);
  const remove = useDeleteStorage(companyId);
  const removeKnowledge = useDeleteKnowledge();
  const roles = useCompanyRolesList(companyId).data;
  const roleIdBySlug = useMemo(
    () => new Map((roles ?? []).map((role) => [role.slug, role.id])),
    [roles],
  );

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
  const door = doorFor(target, companyId, roleIdBySlug);
  const canUpload = door !== null;
  // A browser rooted where no door is can never change anything, so it
  // shows no write controls rather than disabled ones.
  const writableSomewhere = hasDoorsUnder(root);
  /** A knowledge file's scope, when `path` is one; it deletes through that route. */
  const knowledgeOf = (path: string) => {
    const parent = doorFor(parentOf(path), companyId, roleIdBySlug);
    return !path.endsWith('/') && parent?.kind === 'knowledge'
      ? parent.scope
      : undefined;
  };
  const canDelete =
    paths.length > 0 &&
    paths.every(
      (p) =>
        (isWritablePath(p) && p !== 'resources/') ||
        knowledgeOf(p) !== undefined,
    );

  /** Starts an upload into the target: straight away into storage, or after asking. */
  const upload = (items: readonly UploadItem[]) => {
    if (door === null || items.length === 0) return;
    if (door.kind === 'storage') {
      void uploads.start(items, targetName, target, door);
    } else {
      setPending({ items, door, folder: targetName, folderPath: target });
    }
  };

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
      for (const path of paths) {
        const scope = knowledgeOf(path);
        if (scope === undefined) await remove.mutateAsync(path);
        else
          await removeKnowledge.mutateAsync({
            scope,
            filename: path.slice(parentOf(path).length),
          });
      }
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
    <FolderTree
      ref={treeRef}
      companyId={companyId}
      root={root}
      label={label}
      folderLabel={folderLabel}
      selectedKeys={selected}
      onSelectionChange={setSelected}
    />
  );

  return (
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
                files !== null && upload(itemsFromFiles(files, target))
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
                files !== null && upload(itemsFromFiles(files, target))
              }
            >
              <Button
                className="react-aria-Button tcp-button--outline"
                isDisabled={door?.kind !== 'storage'}
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
            isPending={remove.isPending || removeKnowledge.isPending}
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
            : readOnlyReason(target, targetName)}
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
                void itemsFromDrop(event.items, target).then(upload)
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
            <h3 id={previewId} className="storage-browser__preview-name">
              {previewEntry.name}
            </h3>
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
        message={t(
          uploads.clashes?.door.kind === 'storage'
            ? 'storage.replace.message'
            : 'storage.door.replace.message',
          {
            // By the name each will be stored under: a converted file
            // clashes as its `.md`.
            names: (uploads.clashes?.items ?? [])
              .map(({ file }) =>
                uploads.clashes === null
                  ? file.name
                  : storedName(file.name, uploads.clashes.door),
              )
              .join(', '),
            folder: uploads.clashes?.folder ?? '',
          },
        )}
        confirmLabel={t('storage.replace.confirm')}
        cancelLabel={t('storage.replace.skip')}
        portalContainer={portalContainer}
        onConfirm={() => void uploads.replace()}
        onCancel={uploads.skip}
      />
      <ConfirmDialog
        isOpen={pending !== null}
        heading={pending === null ? '' : doorQuestion(pending).heading}
        message={pending === null ? '' : doorQuestion(pending).message}
        confirmLabel={t('storage.door.confirm')}
        cancelLabel={t('storage.door.cancel')}
        portalContainer={portalContainer}
        onConfirm={() => {
          if (pending === null) return;
          setPending(null);
          void uploads.start(
            pending.items,
            pending.folder,
            pending.folderPath,
            pending.door,
          );
        }}
        onCancel={() => setPending(null)}
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
  );
};
