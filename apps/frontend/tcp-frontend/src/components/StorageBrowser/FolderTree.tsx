import { ChevronRight, FileText, Folder, FolderOpen, Lock } from 'lucide-react';
import { createContext, useContext, useState, type Ref } from 'react';
import {
  Button,
  Tree,
  TreeItem,
  TreeItemContent,
  type Key,
  type Selection,
} from 'react-aria-components';
import {
  useStorageFolder,
  type StorageFileEntryDTO,
  type StorageFolderEntryDTO,
} from '../../api/hooks';
import { t } from '../../strings';
import { Icon } from '../Icon/Icon';
import { formatSize } from './format';
import { isWritablePath } from './paths';
import './StorageBrowser.css';

export interface FolderTreeProps {
  readonly companyId: string;
  /** The folder the tree lists: `''` or a path ending in `/`. Never shown above. */
  readonly root: string;
  /** The tree's accessible name. Already resolved through `t`. */
  readonly label: string;
  /** A friendlier name for a folder (a task's folder by its shortcode), or `undefined` for its own. */
  readonly folderLabel?: (path: string) => string | undefined;
  /** Lists folders only, for a host that opens folders rather than files. */
  readonly foldersOnly?: boolean;
  /**
   * Makes each folder an action row: a click or Enter opens it, and the row
   * shows that it does. A tree with this set selects nothing.
   */
  readonly onOpen?: (folder: StorageFolderEntryDTO) => void;
  /** The rows chosen, for a host that acts on a selection (the browser). */
  readonly selectedKeys?: ReadonlySet<Key>;
  readonly onSelectionChange?: (keys: ReadonlySet<Key>) => void;
  /** The tree's element, so a host can send focus back to it. */
  readonly ref?: Ref<HTMLDivElement>;
}

/** What every row needs, without threading it through React Aria's collection. */
interface FolderTreeContextValue {
  readonly companyId: string;
  readonly expanded: ReadonlySet<Key>;
  readonly folderLabel?: (path: string) => string | undefined;
  readonly foldersOnly: boolean;
  readonly onOpen?: (folder: StorageFolderEntryDTO) => void;
}

const FolderTreeContext = createContext<FolderTreeContextValue | null>(null);

const useFolderTree = (): FolderTreeContextValue => {
  const value = useContext(FolderTreeContext);
  if (value === null) throw new Error('A storage row outside FolderTree');
  return value;
};

/**
 * One folder's subfolders, then its files, as tree rows. It is rendered only
 * while its folder is expanded, so a folder's listing is fetched on demand.
 */
const FolderContents = ({ path }: { readonly path: string }) => {
  const { companyId, foldersOnly } = useFolderTree();
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
      {!foldersOnly &&
        listing.data.files.map((entry) => (
          <FileItem key={entry.path} entry={entry} />
        ))}
    </>
  );
};

/**
 * A folder row: expand with its chevron or the arrow keys. In a browser, a
 * click or Space selects it; in a tree that opens folders, a click or Enter
 * opens it. Top-level folders that can't be changed carry a lock. A purpose
 * is read after the name, as part of the row's name.
 */
const FolderItem = ({ entry }: { readonly entry: StorageFolderEntryDTO }) => {
  const { expanded, folderLabel, onOpen } = useFolderTree();
  const name = folderLabel?.(entry.path) ?? entry.name;
  return (
    <TreeItem
      id={entry.path}
      // React Aria names the row from this, so the purpose is read with it.
      textValue={entry.purpose === null ? name : `${name}, ${entry.purpose}`}
      hasChildItems
      onAction={onOpen && (() => onOpen(entry))}
      className={`react-aria-TreeItem storage-browser__row${onOpen ? ' storage-browser__row--opens' : ''}`}
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
            {onOpen && (
              // Decorative: the row's own role says it acts; this shows it.
              <span className="storage-browser__opens">
                <Icon icon={FolderOpen} />
              </span>
            )}
            {entry.purpose !== null && (
              <span className="storage-browser__purpose">{entry.purpose}</span>
            )}
          </>
        )}
      </TreeItemContent>
      {expanded.has(entry.path) ? (
        <FolderContents path={entry.path} />
      ) : (
        <CollapsedPlaceholder path={entry.path} />
      )}
    </TreeItem>
  );
};

/**
 * Stands in for a collapsed folder's unfetched contents. React Aria's Tree
 * (1.20) only treats a row as expandable, with `aria-expanded` and the arrow
 * keys, when it has child items in the collection; `hasChildItems` alone
 * doesn't reach that logic. A collapsed folder's children are never drawn,
 * so this row is never seen, and nothing is fetched until the folder opens.
 */
const CollapsedPlaceholder = ({ path }: { readonly path: string }) => (
  <TreeItem id={`${path}\u0000collapsed`} textValue="" isDisabled>
    <TreeItemContent>{null}</TreeItemContent>
  </TreeItem>
);

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
 * A company's shared storage as a tree rooted at `root`, fetching each folder
 * as it is expanded. The storage browser (002.05) selects rows in it; the
 * office's resources tray (002.08) opens folders from it. One tree, so the
 * two can't drift apart in how a folder reads or moves.
 */
export const FolderTree = ({
  companyId,
  root,
  label,
  folderLabel,
  foldersOnly = false,
  onOpen,
  selectedKeys,
  onSelectionChange,
  ref,
}: FolderTreeProps) => {
  const [expanded, setExpanded] = useState<ReadonlySet<Key>>(new Set());
  const selects = onOpen === undefined && onSelectionChange !== undefined;
  return (
    <FolderTreeContext.Provider
      value={{ companyId, expanded, folderLabel, foldersOnly, onOpen }}
    >
      <Tree
        ref={ref}
        aria-label={label}
        className="react-aria-Tree storage-browser__tree"
        selectionMode={selects ? 'multiple' : 'none'}
        selectedKeys={selects ? selectedKeys : undefined}
        onSelectionChange={(keys: Selection) => {
          // Select-all would pick every row of every open folder; ignore it.
          if (keys !== 'all') onSelectionChange?.(new Set(keys));
        }}
        expandedKeys={expanded}
        onExpandedChange={(keys) => setExpanded(new Set(keys))}
      >
        <FolderContents path={root} />
      </Tree>
    </FolderTreeContext.Provider>
  );
};
