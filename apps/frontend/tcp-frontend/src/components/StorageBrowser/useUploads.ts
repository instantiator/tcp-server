import { useState } from 'react';
import {
  isDirectoryDropItem,
  isFileDropItem,
  type DirectoryDropItem,
  type DropItem,
  type FileDropItem,
} from 'react-aria-components';
import { useUploadStorageFile } from '../../api/hooks';
import { ApiError } from '../../api/errors';
import { ANNOUNCE_IMMEDIATE_MS, announce } from '../../announce/announcer';
import { t, tCount } from '../../strings';

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
 * Uploads files one at a time, then says once how it went. A name that is
 * already taken (409) isn't an error: those are gathered and the caller asks
 * "Replace?" once, for all of them, before anything is overwritten.
 *
 * ponytail: one at a time; run a few at once if folder uploads feel slow.
 */
export const useUploads = (companyId: string) => {
  const upload = useUploadStorageFile(companyId);
  const [busy, setBusy] = useState(false);
  const [clashes, setClashes] = useState<Clashes | null>(null);
  const [failures, setFailures] = useState<readonly UploadFailure[]>([]);

  const send = async (items: readonly UploadItem[], overwrite: boolean) => {
    let done = 0;
    const clashed: UploadItem[] = [];
    const failed: UploadFailure[] = [];
    setBusy(true);
    for (const item of items) {
      try {
        await upload.mutateAsync({ ...item, overwrite });
        done += 1;
      } catch (error) {
        if (!overwrite && error instanceof ApiError && error.status === 409) {
          clashed.push(item);
        } else {
          failed.push({ name: nameOf(item.path), reason: reasonOf(error) });
        }
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

  /** Uploads `items` into `folder` (its display name says where, for the announcement). */
  const start = async (items: readonly UploadItem[], folder: string) => {
    if (items.length === 0) return;
    setFailures([]);
    const { done, clashed, failed } = await send(items, false);
    if (clashed.length > 0)
      setClashes({ items: clashed, folder, done, failed });
    else finish(done, failed, folder);
  };

  /** "Replace": overwrites the clashing files; their old versions stay in the history. */
  const replace = async () => {
    if (clashes === null) return;
    setClashes(null);
    const { done, failed } = await send(clashes.items, true);
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
