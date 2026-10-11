import { storagePrompts } from '../storage-prompts';
import { fill } from './fill';
import {
  FileEntry,
  StorageApiService,
  StorageScope,
} from './storage-api.service';

/** Most company resources named in a hint. */
const MAX_HINTS = 3;

/**
 * A hint for a model that asked a working-file or material tool for a file
 * that isn't there: if a live company resource has the same file name, name
 * the `read_resource` call that would reach it. Returns '' when nothing
 * matches, and also when the lookup itself fails, so the hint can never
 * replace the reply it decorates.
 */
export async function resourceHint(
  storage: StorageApiService,
  scope: StorageScope,
  filename: string,
): Promise<string> {
  try {
    // The live folder is always the last read layer.
    const prefix = scope.resources.readPrefixes.at(-1);
    const name = filename.trim().replace(/\\/g, '/').split('/').at(-1);
    if (!prefix || !name) return '';
    const { entries } = await storage.post<{ entries: FileEntry[] }>('list', {
      prefix,
      all: true,
    });
    const calls = entries
      .map(({ key }) => key.slice(prefix.length))
      .filter((path) => path.split('/').at(-1) === name)
      .sort()
      .slice(0, MAX_HINTS)
      .map((path) => `read_resource('${path}')`);
    return calls.length === 0
      ? ''
      : fill(storagePrompts.resources_same_name_hint, {
          calls: calls.join(' or '),
        });
  } catch {
    // The hint is a courtesy; the original reply stands without it.
    return '';
  }
}
