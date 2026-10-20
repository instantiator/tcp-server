import { Pencil, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from 'react-aria-components';
import { announce } from '../../../announce/announcer';
import type { MemoryDto } from '../../../api/dtos';
import { ApiError } from '../../../api/errors';
import {
  useCreateMemory,
  useDeleteMemory,
  useLiveRoleMemories,
  useLiveRoleMemoryChanges,
  useReloadRoleMemories,
  useUpdateMemory,
} from '../../../api/hooks';
import { ConfirmDialog } from '../../../components/Dialog/ConfirmDialog';
import { EmptyState } from '../../../components/EmptyState/EmptyState';
import { ErrorState } from '../../../components/ErrorState/ErrorState';
import { LoadingState } from '../../../components/LoadingState/LoadingState';
import { OutOfDateNotice } from '../../../components/OutOfDateNotice/OutOfDateNotice';
import {
  describeChanges,
  type ChangeWords,
} from '../../../components/RecordSheet/describeChanges';
import { RoundIconButton } from '../../../components/RoundIconButton/RoundIconButton';
import { t } from '../../../strings';
import { MemoryDialog } from './MemoryDialog';

/** This panel is the one writer on this announcer channel. */
const MEMORY_CHANNEL = 'memory';

/** How the out-of-date notice words memory changes. */
const MEMORY_WORDS: ChangeWords = {
  changed: 'memory.outOfDate.changed',
  deleted: 'memory.outOfDate.deleted',
  added: 'memory.outOfDate.added',
};

const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** The start of a memory, so each row's buttons have a name of their own (WCAG 2.4.6). */
const preview = (content: string): string =>
  content.length > 40 ? `${content.slice(0, 40)}…` : content;

/** An error's message for the reader: the server's own words, or a generic line. */
const messageOf = (error: unknown): string =>
  error instanceof ApiError ? error.message : t('records.error.generic');

/** Which dialog is open: adding, or editing one memory. */
type Editing =
  | { readonly kind: 'add' }
  | { readonly kind: 'edit'; readonly memory: MemoryDto };

/** The memories as a table: each row's content is its header, so focus can land on it. */
const MemoryTable = ({
  memories,
  canWrite,
  labelledBy,
  rowRefs,
  onEdit,
  onDelete,
}: {
  readonly memories: readonly MemoryDto[];
  /** Without an embedding model a memory can be deleted but not reworded. */
  readonly canWrite: boolean;
  readonly labelledBy: string;
  /** Row headers by memory id, for the panel's focus moves. */
  readonly rowRefs: Map<string, HTMLTableCellElement>;
  readonly onEdit: (memory: MemoryDto) => void;
  readonly onDelete: (memory: MemoryDto) => void;
}) => (
  <table className="tcp-table" aria-labelledby={labelledBy}>
    <thead>
      <tr>
        <th scope="col">{t('memory.column.content')}</th>
        <th scope="col">{t('memory.column.tags')}</th>
        <th scope="col">{t('memory.column.source')}</th>
        <th scope="col">{t('memory.column.updated')}</th>
        <th scope="col">{t('memory.column.actions')}</th>
      </tr>
    </thead>
    <tbody>
      {memories.map((memory) => (
        <tr key={memory.id}>
          <th
            scope="row"
            tabIndex={-1}
            ref={(cell) => {
              if (cell === null) rowRefs.delete(memory.id);
              else rowRefs.set(memory.id, cell);
            }}
          >
            {memory.content}
          </th>
          <td>{memory.tags.join(', ')}</td>
          <td>
            {t(
              memory.agentId === null
                ? 'memory.source.person'
                : 'memory.source.agent',
            )}
          </td>
          <td>{dateFormat.format(new Date(memory.updatedAt))}</td>
          <td>
            {canWrite && (
              <RoundIconButton
                icon={Pencil}
                label={t('memory.edit', { preview: preview(memory.content) })}
                onPress={() => onEdit(memory)}
              />
            )}
            <RoundIconButton
              icon={Trash2}
              label={t('memory.delete', { preview: preview(memory.content) })}
              onPress={() => onDelete(memory)}
            />
          </td>
        </tr>
      ))}
    </tbody>
  </table>
);

/**
 * One role's memories (002.06): what its agents recall when they start work.
 * The role dialog's Memories tab renders it.
 *
 * **Changes made elsewhere don't move the table.** An agent storing a memory
 * while this is open shows a notice with a Reload button, as the records
 * sheet does (001.05). Edits made here update the table straight away.
 *
 * **Focus (ADR-027).** After a delete it moves to the next memory, or to Add
 * when none is left. After an add it moves to the new memory. A closed
 * dialog returns focus to its opener. Reload puts it on the heading.
 */
export const MemoryPanel = ({ roleId }: { readonly roleId: string }) => {
  const headingId = useId();
  const list = useLiveRoleMemories(roleId);
  const changes = useLiveRoleMemoryChanges(roleId, list.data);
  const reload = useReloadRoleMemories(roleId);
  const create = useCreateMemory(roleId);
  const update = useUpdateMemory(roleId);
  const remove = useDeleteMemory(roleId);

  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<MemoryDto | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The memory to focus once it renders; `null` means Add (or the heading).
  const [focusTarget, setFocusTarget] = useState<string | null | undefined>(
    undefined,
  );
  const rowRefs = useRef(new Map<string, HTMLTableCellElement>());
  const addRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (focusTarget === undefined || list.isFetching) return;
    const row =
      focusTarget === null ? undefined : rowRefs.current.get(focusTarget);
    (row ?? addRef.current ?? headingRef.current)?.focus();
    setFocusTarget(undefined);
  }, [focusTarget, list.isFetching, list.data]);

  const memories = list.data?.memories ?? [];
  const canWrite = list.data?.canWrite === true;

  const save = async (content: string, tags: string[]): Promise<void> => {
    if (editing?.kind === 'edit') {
      await update.mutateAsync({ id: editing.memory.id, content, tags });
      setEditing(null);
      announce({ channel: MEMORY_CHANNEL, change: 'memory.announce.saved' });
    } else {
      const added = await create.mutateAsync({ content, tags });
      setEditing(null);
      setFocusTarget(added.id);
      announce({ channel: MEMORY_CHANNEL, change: 'memory.announce.added' });
    }
  };

  const confirmDelete = async (memory: MemoryDto): Promise<void> => {
    setDeleting(null);
    const index = memories.findIndex((m) => m.id === memory.id);
    const next = memories[index + 1] ?? memories[index - 1];
    try {
      await remove.mutateAsync(memory.id);
      announce({ channel: MEMORY_CHANNEL, change: 'memory.announce.deleted' });
      setFocusTarget(next?.id ?? null);
    } catch (error) {
      setProblem(t('memory.deleteFailed', { message: messageOf(error) }));
    }
  };

  const reloadNow = (): void => {
    reload();
    headingRef.current?.focus();
    announce({ channel: MEMORY_CHANNEL, change: 'memory.announce.reloaded' });
  };

  return (
    <section aria-labelledby={headingId} className="memory-panel">
      <h3 id={headingId} ref={headingRef} tabIndex={-1}>
        {t('memory.heading')}
      </h3>
      <p>{t('memory.intro')}</p>

      {changes.any && (
        <OutOfDateNotice
          message={describeChanges(changes, MEMORY_WORDS)}
          announcement="memory.announce.outOfDate"
          onReload={reloadNow}
          channel={MEMORY_CHANNEL}
        />
      )}

      {list.data !== undefined &&
        (canWrite ? (
          <Button
            ref={addRef}
            className="react-aria-Button"
            onPress={() => setEditing({ kind: 'add' })}
          >
            {t('memory.add')}
          </Button>
        ) : (
          <p>{t('memory.noEmbedding')}</p>
        ))}
      {problem !== null && (
        <p className="tcp-field__error" role="alert">
          {problem}
        </p>
      )}

      {list.isPending ? (
        <LoadingState label={t('memory.loading')} />
      ) : list.isError ? (
        <ErrorState
          message={t('memory.error')}
          channel={MEMORY_CHANNEL}
          onRetry={() => void list.refetch()}
        />
      ) : memories.length === 0 ? (
        <EmptyState heading={t('memory.empty')} headingLevel={4}>
          <p>{t('memory.emptyHint')}</p>
        </EmptyState>
      ) : (
        <>
          <MemoryTable
            memories={memories}
            canWrite={canWrite}
            labelledBy={headingId}
            rowRefs={rowRefs.current}
            onEdit={(memory) => setEditing({ kind: 'edit', memory })}
            onDelete={setDeleting}
          />
          {list.data.truncated && <p>{t('memory.truncated')}</p>}
        </>
      )}

      {editing !== null && (
        <MemoryDialog
          initial={editing.kind === 'edit' ? editing.memory : undefined}
          onSave={save}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        isOpen={deleting !== null}
        heading={t('memory.deleteHeading')}
        message={t('memory.deleteMessage')}
        confirmLabel={t('memory.deleteConfirm')}
        onConfirm={() => {
          if (deleting !== null) void confirmDelete(deleting);
        }}
        onCancel={() => setDeleting(null)}
      />
    </section>
  );
};
