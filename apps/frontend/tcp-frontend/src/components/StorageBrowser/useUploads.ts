import { useState } from 'react';
import {
  isDirectoryDropItem,
  isFileDropItem,
  type DirectoryDropItem,
  type DropItem,
  type FileDropItem,
} from 'react-aria-components';
import {
  useDoorUpload,
  useFolderFileNames,
  type UploadDoor,
} from '../../api/hooks';
import { ApiError } from '../../api/errors';
import { ANNOUNCE_IMMEDIATE_MS, announce } from '../../announce/announcer';
import { t, tCount } from '../../strings';
import { storedName } from './paths';

/** The browser's one announcer channel: uploads, deletes and restores. */
export const STORAGE_CHANNEL = 'storage';

/** One file to upload, and where it goes (relative to the company folder). */
export interface UploadItem {
  readonly path: string;
  readonly file: File;
}

/** A file the server refused, with its reason, for the list under the toolbar. */
export interface UploadFailure {
  readonly name: string;
  readonly reason: string;
}

/** Uploads waiting on the "Replace?" answer, with how the rest went. */
interface Clashes {
  readonly items: readonly UploadItem[];
  readonly folder: string;
  readonly door: UploadDoor;
  readonly done: number;
  readonly failed: readonly UploadFailure[];
}

const nameOf = (path: string): string => path.split('/').pop() ?? path;

/** The server's own words for a refusal, or a generic line. */
const reasonOf = (error: unknown): string =>
  error instanceof ApiError ? error.message : t('records.error.generic');

/** Files picked with the file picker, under `folder`; a folder pick keeps its relative paths. */
export const itemsFromFiles = (
  files: Iterable<File>,
  folder: string,
): UploadItem[] =>
  [...files].map((file) => ({
    path: folder + (file.webkitRelativePath || file.name),
    file,
  }));

/** Dropped files and folders, under `folder`; a folder's files keep their place in it. */
export const itemsFromDrop = async (
  items: readonly DropItem[],
  folder: string,
): Promise<UploadItem[]> => {
  const out: UploadItem[] = [];
  const walk = async (
    item: FileDropItem | DirectoryDropItem,
    prefix: string,
  ): Promise<void> => {
    if (isFileDropItem(item)) {
      out.push({ path: prefix + item.name, file: await item.getFile() });
    } else {
      for await (const entry of item.getEntries()) {
        await walk(entry, `${prefix}${item.name}/`);
      }
    }
  };
  for (const item of items) {
    if (isFileDropItem(item) || isDirectoryDropItem(item)) {
      await walk(item, folder);
    }
  }
  return out;
};

/**
 * Splits a door's items into the refused (inside a subfolder: doors are
 * flat), the clashing (their stored name is in `taken`) and the fresh.
 */
const sortForDoor = (
  items: readonly UploadItem[],
  folderPath: string,
  door: UploadDoor,
  taken: ReadonlySet<string>,
) => {
  const flat = items.filter(
    (item) => !item.path.slice(folderPath.length).includes('/'),
  );
  const refused: UploadFailure[] = items
    .filter((item) => !flat.includes(item))
    .map((item) => ({
      name: item.path.slice(folderPath.length),
      reason: t('storage.door.noFolders'),
    }));
  const clashing = flat.filter((item) =>
    taken.has(storedName(item.file.name, door)),
  );
  const fresh = flat.filter((item) => !clashing.includes(item));
  return { refused, clashing, fresh };
};

/**
 * Uploads files one at a time through their folder's door, then says once
 * how it went. Nothing is overwritten without the caller asking "Replace?"
 * once, for every clashing name:
 *
 * - into `resources/`, a name that is already taken comes back as a 409;
 * - through a knowledge or materials door, the names are checked first
 *   against the folder's listing, by the name each file will be stored
 *   under. Those routes don't all refuse a clash, and a 409 from them means
 *   something else (a task that has started), so it is a failure.
 *
 * Those doors are flat, so a file inside a dropped folder is refused.
 *
 * ponytail: one at a time; run a few at once if folder uploads feel slow.
 */
export const useUploads = (companyId: string) => {
  const upload = useDoorUpload(companyId);
  const fileNames = useFolderFileNames(companyId);
  const [busy, setBusy] = useState(false);
  const [clashes, setClashes] = useState<Clashes | null>(null);
  const [failures, setFailures] = useState<readonly UploadFailure[]>([]);

  const send = async (
    items: readonly UploadItem[],
    door: UploadDoor,
    overwrite: boolean,
  ) => {
    let done = 0;
    const clashed: UploadItem[] = [];
    const failed: UploadFailure[] = [];
    setBusy(true);
    for (const item of items) {
      try {
        await upload.mutateAsync({
          ...item,
          door,
          overwrite,
          storedAs: storedName(item.file.name, door),
        });
        done += 1;
      } catch (error) {
        const clash =
          door.kind === 'storage' &&
          !overwrite &&
          error instanceof ApiError &&
          error.status === 409;
        if (clash) clashed.push(item);
        else failed.push({ name: nameOf(item.path), reason: reasonOf(error) });
      }
    }
    setBusy(false);
    return { done, clashed, failed };
  };

  const finish = (
    done: number,
    failed: readonly UploadFailure[],
    folder: string,
  ) => {
    setFailures(failed);
    if (done > 0) {
      announce({
        channel: STORAGE_CHANNEL,
        change: 'storage.uploaded',
        params: { files: tCount('storage.fileCount', done), folder },
        throttleMs: ANNOUNCE_IMMEDIATE_MS,
      });
    }
    if (failed.length > 0) {
      announce({
        channel: STORAGE_CHANNEL,
        change: 'storage.uploadFailed',
        politeness: 'assertive',
      });
    }
  };

  /**
   * Uploads `items` into the folder at `folderPath` through `door`; `folder`
   * is its display name, for the announcement and the "Replace?" question.
   */
  const start = async (
    items: readonly UploadItem[],
    folder: string,
    folderPath: string,
    door: UploadDoor,
  ) => {
    if (items.length === 0) return;
    setFailures([]);
    if (door.kind === 'storage') {
      const { done, clashed, failed } = await send(items, door, false);
      if (clashed.length > 0)
        setClashes({ items: clashed, folder, door, done, failed });
      else finish(done, failed, folder);
      return;
    }
    // An unreadable listing checks nothing; the route still has its say.
    const taken = await fileNames(folderPath).catch(() => new Set<string>());
    const { refused, clashing, fresh } = sortForDoor(
      items,
      folderPath,
      door,
      taken,
    );
    const { done, failed } = await send(fresh, door, false);
    const allFailed = [...refused, ...failed];
    if (clashing.length > 0)
      setClashes({ items: clashing, folder, door, done, failed: allFailed });
    else finish(done, allFailed, folder);
  };

  /** "Replace": overwrites the clashing files. */
  const replace = async () => {
    if (clashes === null) return;
    setClashes(null);
    const { done, failed } = await send(clashes.items, clashes.door, true);
    finish(clashes.done + done, [...clashes.failed, ...failed], clashes.folder);
  };

  /** "Skip": leaves the existing files as they are. */
  const skip = () => {
    if (clashes === null) return;
    setClashes(null);
    finish(clashes.done, clashes.failed, clashes.folder);
  };

  return { start, busy, clashes, replace, skip, failures };
};
