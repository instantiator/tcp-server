import { Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  ToolResult,
  extractServerErrorMessage,
  normaliseResourcePath,
  ok,
} from '@tcp/shared';
import { storagePrompts } from '../storage-prompts';
import { storageToolDescriptions } from '../storage-tool-descriptions';
import { fill } from './fill';
import {
  FileEntry,
  FileProperties,
  StorageApiService,
  StorageScope,
} from './storage-api.service';

/** Most lines `list_resources` prints before it points the model at a folder. */
const MAX_TREE_LINES = 200;

/** Most "did you mean" candidates named in a not-found reply. */
const MAX_SUGGESTIONS = 3;

/** Extensions that can't be shown as text. */
const BINARY_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'zip',
]);

const PATH_PARAM = z
  .string()
  .describe(
    "Path under the company's resources, e.g. 'price-list.md' or 'invoices/INV-0042.md'.",
  );

/** Every resource the caller can see, by path under `resources/`. */
type Merged = Map<string, { key: string; draft: boolean }>;

/** One line of the folder tree. */
interface TreeLine {
  text: string;
  /** Path of a folder line, so its README can supply the purpose. */
  folder?: string;
}

/** A folder's direct children, for tree building. */
interface FolderNode {
  folders: Map<string, FolderNode>;
  files: Map<string, boolean>;
}

/**
 * The company-resource tier: long-lived company documents under
 * `{slug}/resources/`. Reads fall through the caller's layers (its own draft,
 * earlier steps, then the live folder); writes go to the scope's write prefix,
 * or are refused when the caller's mode may not change resources.
 *
 * Replies aim to correct a small model: a wrong path gets the files that do
 * exist and a "did you mean", rather than a bare error.
 *
 * The `agentId` field on these tools is injected by the runtime and never
 * supplied by the model.
 */
@Injectable()
export class ResourceToolsService {
  constructor(private readonly storage: StorageApiService) {}

  /** Registers this tier's tools on a fresh server instance. */
  register(server: McpServer): void {
    const agentIdField = z.uuid().describe('The calling agent UUID.');

    server.registerTool(
      'list_resources',
      {
        description: storageToolDescriptions.list_resources,
        inputSchema: {
          agentId: agentIdField,
          path: z
            .string()
            .optional()
            .describe('A folder to show. Leave out for the top folder.'),
        },
      },
      ({ agentId, path }) =>
        this.run(agentId, (scope) => this.listResources(scope, path)),
    );

    server.registerTool(
      'read_resource',
      {
        description: storageToolDescriptions.read_resource,
        inputSchema: { agentId: agentIdField, path: PATH_PARAM },
      },
      ({ agentId, path }) =>
        this.run(agentId, (scope) => this.readResource(scope, path)),
    );

    server.registerTool(
      'write_resource',
      {
        description: storageToolDescriptions.write_resource,
        inputSchema: {
          agentId: agentIdField,
          path: PATH_PARAM,
          content: z.string().describe('The full content of the resource.'),
        },
      },
      ({ agentId, path, content }) =>
        this.run(agentId, (scope) =>
          this.writeResource(agentId, scope, path, content),
        ),
    );

    server.registerTool(
      'append_resource',
      {
        description: storageToolDescriptions.append_resource,
        inputSchema: {
          agentId: agentIdField,
          path: PATH_PARAM,
          content: z.string().describe('The text to add at the end.'),
        },
      },
      ({ agentId, path, content }) =>
        this.run(agentId, (scope) =>
          this.appendResource(agentId, scope, path, content),
        ),
    );

    server.registerTool(
      'replace_in_resource',
      {
        description: storageToolDescriptions.replace_in_resource,
        inputSchema: {
          agentId: agentIdField,
          path: PATH_PARAM,
          find: z
            .string()
            .describe('The literal string to find (all occurrences replaced).'),
          replace: z.string().describe('The replacement string.'),
        },
      },
      ({ agentId, path, find, replace }) =>
        this.run(agentId, (scope) =>
          this.replaceInResource(agentId, scope, path, find, replace),
        ),
    );
  }

  /**
   * Resolves the caller's scope and runs `action`. Failures — including a
   * validation 422 with its hint — come back as text, never as an exception.
   */
  private async run(
    agentId: string,
    action: (scope: StorageScope) => Promise<string>,
  ): Promise<ToolResult> {
    try {
      return ok(await action(await this.storage.fetchScope(agentId)));
    } catch (e) {
      return ok(extractServerErrorMessage(e));
    }
  }

  private async listResources(
    scope: StorageScope,
    raw: string | undefined,
  ): Promise<string> {
    const parsed = normaliseResourcePath(raw, slugOf(scope), { folder: true });
    if ('error' in parsed) return parsed.error;
    const folder = parsed.path;

    const merged = await this.layers(scope);
    if (merged.size === 0) {
      return (
        storagePrompts.resources_none +
        (scope.resources.writePrefix
          ? storagePrompts.resources_create_hint
          : '')
      );
    }
    if (merged.has(folder)) {
      return fill(storagePrompts.resources_is_file, { path: folder });
    }
    if (isFolder(merged, folder)) return this.tree(merged, folder);

    return `${fill(storagePrompts.resources_no_folder, { folder })}\n${await this.tree(merged, deepestFolder(merged, folder))}`;
  }

  private async readResource(
    scope: StorageScope,
    raw: string,
  ): Promise<string> {
    const parsed = normaliseResourcePath(raw, slugOf(scope));
    if ('error' in parsed) return parsed.error;
    const path = parsed.path;

    const key = await this.findKey(scope, path);
    if (!key) return this.notFound(scope, path);
    if (BINARY_EXTENSIONS.has(extensionOf(path))) {
      return fill(storagePrompts.resources_binary, { path });
    }
    const { content } = await this.storage.post<{ content: string }>('read', {
      path: key,
    });
    return content;
  }

  private async writeResource(
    agentId: string,
    scope: StorageScope,
    raw: string,
    content: string,
  ): Promise<string> {
    const target = this.writeTarget(scope, raw);
    if (typeof target === 'string') return target;
    const { path, key } = target;

    const existed = (await this.findKey(scope, path)) !== null;
    // Judged before the write, while the folder is still as the model found it.
    const hint = existed ? '' : await this.newFolderHint(scope, path);
    await this.storage.post('write', {
      path: key,
      content,
      overwrite: true,
      originators: { agent: agentId },
    });
    const reply = fill(
      existed
        ? storagePrompts.resources_replaced
        : storagePrompts.resources_created,
      { path },
    );
    return reply + this.draftNote(scope) + hint;
  }

  private async appendResource(
    agentId: string,
    scope: StorageScope,
    raw: string,
    content: string,
  ): Promise<string> {
    const target = this.writeTarget(scope, raw);
    if (typeof target === 'string') return target;
    const { path, key } = target;

    await this.copyIntoWriteLayer(scope, path, key);
    const { created } = await this.storage.post<{ created: boolean }>(
      'append',
      { path: key, content, originators: { agent: agentId } },
    );
    return (
      fill(
        created
          ? storagePrompts.resources_created
          : storagePrompts.resources_appended,
        { path },
      ) + this.draftNote(scope)
    );
  }

  private async replaceInResource(
    agentId: string,
    scope: StorageScope,
    raw: string,
    find: string,
    replace: string,
  ): Promise<string> {
    const target = this.writeTarget(scope, raw);
    if (typeof target === 'string') return target;
    const { path, key } = target;

    if (!(await this.copyIntoWriteLayer(scope, path, key))) {
      return this.notFound(scope, path);
    }
    const { count } = await this.storage.post<{ count: number }>('replace', {
      path: key,
      find,
      replace,
      originators: { agent: agentId },
    });
    return (
      fill(storagePrompts.resources_replaced_count, { count, path }) +
      this.draftNote(scope)
    );
  }

  /**
   * The checks every change needs: the mode may change resources, and the path
   * is valid. Returns the path and its key in the write layer, or the text to
   * send back to the model.
   */
  private writeTarget(
    scope: StorageScope,
    raw: string,
  ): { path: string; key: string } | string {
    const { writePrefix } = scope.resources;
    if (writePrefix === null) return storagePrompts.resources_read_only;
    const parsed = normaliseResourcePath(raw, slugOf(scope));
    if ('error' in parsed) return parsed.error;
    return { path: parsed.path, key: writePrefix + parsed.path };
  }

  /**
   * Copy-on-first-change: if the file lives only in another layer, copy it to
   * the write layer so an append or replace edits the full current content.
   * Returns false when no layer has the file.
   */
  private async copyIntoWriteLayer(
    scope: StorageScope,
    path: string,
    key: string,
  ): Promise<boolean> {
    // The write layer is a read layer too, and is checked before the others in
    // draft mode, so a different key means the write layer has no copy yet.
    const existing = await this.findKey(scope, path);
    if (existing && existing !== key) {
      await this.storage.post('copy', { source: existing, destination: key });
    }
    return existing !== null;
  }

  private draftNote(scope: StorageScope): string {
    return scope.resources.mode === 'draft'
      ? storagePrompts.resources_draft_note
      : '';
  }

  /** Suggests a README for the first file in a new, non-top folder. */
  private async newFolderHint(
    scope: StorageScope,
    path: string,
  ): Promise<string> {
    const folder = parentOf(path);
    if (folder === '' || path === `${folder}/README.md`) return '';
    const merged = await this.layers(scope);
    return isFolder(merged, folder)
      ? ''
      : fill(storagePrompts.resources_new_folder_hint, { folder });
  }

  /** The first read layer that holds `path`, as an object key. */
  private async findKey(
    scope: StorageScope,
    path: string,
  ): Promise<string | null> {
    for (const prefix of scope.resources.readPrefixes) {
      const key = prefix + path;
      const props = await this.storage.post<FileProperties>('properties', {
        path: key,
      });
      if (props.exists) return key;
    }
    return null;
  }

  /** Every visible resource, the first layer that has a path winning. */
  private async layers(scope: StorageScope): Promise<Merged> {
    const { readPrefixes } = scope.resources;
    const merged: Merged = new Map();
    for (const [i, prefix] of readPrefixes.entries()) {
      const { entries } = await this.storage.post<{ entries: FileEntry[] }>(
        'list',
        { prefix, all: true },
      );
      for (const { key } of entries) {
        const rel = key.slice(prefix.length);
        if (rel !== '' && !merged.has(rel)) {
          merged.set(rel, { key, draft: i < readPrefixes.length - 1 });
        }
      }
    }
    return merged;
  }

  /** A not-found reply that shows what does exist, and a likely fix. */
  private async notFound(scope: StorageScope, path: string): Promise<string> {
    const merged = await this.layers(scope);
    const folder = parentOf(path);
    let reply: string;
    if (isFolder(merged, path)) {
      reply = fill(storagePrompts.resources_is_folder, {
        path,
        files: childNames(merged, path).join(', '),
      });
    } else if (isFolder(merged, folder)) {
      const names = childNames(merged, folder);
      reply = fill(
        names.length > 0
          ? storagePrompts.resources_no_resource
          : storagePrompts.resources_no_resource_empty,
        { path, folder: folder || 'resources', files: names.join(', ') },
      );
    } else {
      reply = `${fill(storagePrompts.resources_no_folder, { folder })}\n${await this.tree(merged, deepestFolder(merged, folder))}`;
    }
    return reply + suggestions(merged, path);
  }

  /** The folder tree under `folder`, each folder with its README purpose. */
  private async tree(merged: Merged, folder: string): Promise<string> {
    const root = buildTree(merged, folder);
    const lines: TreeLine[] = [
      { text: `${folder.split('/').at(-1) || 'resources'}/`, folder },
    ];
    walk(root, folder, 1, lines);

    const shown = lines.slice(0, MAX_TREE_LINES);
    const out = await Promise.all(
      shown.map(async ({ text, folder: f }) => {
        if (f === undefined) return text;
        const purpose = await this.purpose(merged, f);
        return purpose ? `${text} — ${purpose}` : text;
      }),
    );
    if (lines.length > shown.length) {
      out.push(
        fill(storagePrompts.resources_more, {
          count: lines.length - shown.length,
        }),
      );
    }
    return out.join('\n');
  }

  /** The first non-empty line of a folder's README, or '' if it has none. */
  private async purpose(merged: Merged, folder: string): Promise<string> {
    const readme = merged.get(folder ? `${folder}/README.md` : 'README.md');
    if (!readme) return '';
    try {
      const { content } = await this.storage.post<{ content: string }>('read', {
        path: readme.key,
      });
      const first = content.split('\n').find((l) => l.trim() !== '');
      return first?.replace(/^[#\s]+/, '').trim() ?? '';
    } catch {
      // A README that can't be read just means no purpose is shown.
      return '';
    }
  }
}

/** The company slug, from its folder prefix (`{slug}/`). */
function slugOf(scope: StorageScope): string {
  return scope.companyPrefix.replace(/\/$/, '');
}

function extensionOf(path: string): string {
  const name = path.split('/').at(-1) ?? '';
  return name.includes('.') ? (name.split('.').at(-1) ?? '').toLowerCase() : '';
}

function stemOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** The folder part of a path; '' for the top folder. */
function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** True for the top folder, and for any folder holding a file at any depth. */
function isFolder(merged: Merged, folder: string): boolean {
  if (folder === '') return true;
  for (const rel of merged.keys())
    if (rel.startsWith(`${folder}/`)) return true;
  return false;
}

/** The nearest folder at or above `folder` that exists; the top always does. */
function deepestFolder(merged: Merged, folder: string): string {
  let f = folder;
  while (!isFolder(merged, f)) f = parentOf(f);
  return f;
}

/** Direct children of a folder: folders (with `/`) first, then files. */
function childNames(merged: Merged, folder: string): string[] {
  const prefix = folder === '' ? '' : `${folder}/`;
  const folders = new Set<string>();
  const files = new Set<string>();
  for (const rel of merged.keys()) {
    if (!rel.startsWith(prefix)) continue;
    const [head, ...rest] = rel.slice(prefix.length).split('/');
    (rest.length > 0 ? folders : files).add(
      rest.length > 0 ? `${head}/` : head,
    );
  }
  return [...[...folders].sort(), ...[...files].sort()];
}

/** Builds the nested folder structure beneath `folder`. */
function buildTree(merged: Merged, folder: string): FolderNode {
  const root: FolderNode = { folders: new Map(), files: new Map() };
  const prefix = folder === '' ? '' : `${folder}/`;
  for (const [rel, { draft }] of merged) {
    if (!rel.startsWith(prefix)) continue;
    const segments = rel.slice(prefix.length).split('/');
    const name = segments.pop() ?? '';
    let node = root;
    for (const seg of segments) {
      let next = node.folders.get(seg);
      if (!next) {
        next = { folders: new Map(), files: new Map() };
        node.folders.set(seg, next);
      }
      node = next;
    }
    node.files.set(name, draft);
  }
  return root;
}

/** Appends a node's children as indented lines: folders first, by name. */
function walk(
  node: FolderNode,
  path: string,
  depth: number,
  lines: TreeLine[],
): void {
  const indent = '  '.repeat(depth);
  for (const name of [...node.folders.keys()].sort()) {
    const childPath = path ? `${path}/${name}` : name;
    lines.push({ text: `${indent}${name}/`, folder: childPath });
    walk(node.folders.get(name) as FolderNode, childPath, depth + 1, lines);
  }
  for (const name of [...node.files.keys()].sort()) {
    lines.push({
      text: `${indent}${name}${node.files.get(name) ? ' (draft)' : ''}`,
    });
  }
}

/**
 * " Did you mean 'x'?" for a file in the same folder with the same name but a
 * different extension, else a file elsewhere with the same name; '' if none.
 */
function suggestions(merged: Merged, path: string): string {
  const name = path.split('/').at(-1) ?? '';
  const folder = parentOf(path);
  const others = [...merged.keys()].filter((p) => p !== path);
  let found = others.filter(
    (p) =>
      parentOf(p) === folder &&
      stemOf(p.split('/').at(-1) ?? '') === stemOf(name),
  );
  if (found.length === 0) {
    found = others.filter((p) => p.split('/').at(-1) === name);
  }
  if (found.length === 0) return '';
  const names = found
    .sort()
    .slice(0, MAX_SUGGESTIONS)
    .map((p) => `'${p}'`)
    .join(' or ');
  return fill(storagePrompts.resources_did_you_mean, { names });
}
