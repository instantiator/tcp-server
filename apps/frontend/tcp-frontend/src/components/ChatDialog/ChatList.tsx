import { Ear, MessageCircle } from 'lucide-react';
import { useEffect, useRef, useState, type Ref } from 'react';
import {
  CheckboxButton,
  CheckboxField,
  Header,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  ListBoxSection,
  SearchField,
  Text,
} from 'react-aria-components';
import { announce } from '../../announce/announcer';
import {
  useCompanyRolesList,
  useLiveAssignmentsList,
  useLiveCompanyAgentsList,
  useLiveCompanyTasksList,
  useTranscriptSearch,
} from '../../api/hooks';
import { modeLabel } from '../../api/modeLabel';
import { ACTIVE_ASSIGNMENT_STATUSES } from '../../api/statuses';
import { t, type StringKey } from '../../strings';
import { AddNewMenu } from '../AddNew/AddNewMenu';
import { Icon } from '../Icon/Icon';
import type { Eavesdrop } from './eavesdropStorage';
import type { Conversation } from './useChat';
import { useActivityStamps } from './useActivityStamps';

/** How long typing pauses before the transcripts are searched. */
const SEARCH_DEBOUNCE_MS = 300;

/** The three groups, in reading order. */
type Group = 'chats' | 'running' | 'finished';

const GROUPS: readonly { id: Group; heading: StringKey }[] = [
  { id: 'chats', heading: 'chat.list.group.chats' },
  { id: 'running', heading: 'chat.list.group.running' },
  { id: 'finished', heading: 'chat.list.group.finished' },
];

/** When a chat started: its only visible difference from another chat with the same role. */
const startedFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/**
 * Whether an assignment is over. Read from the assignment, not its agent: the
 * agents list holds only active agents, so a finished one isn't in it at all.
 * An assignment not found yet is not finished.
 */
const isFinished = (status: string | undefined): boolean =>
  status !== undefined &&
  !(ACTIVE_ASSIGNMENT_STATUSES as readonly string[]).includes(status);

/** One view in the list: a role chat, or an agent being listened in on. */
interface Row {
  readonly conversation: Conversation;
  readonly group: Group;
  readonly archived: boolean;
  /** When it last did something worth re-sorting for. */
  readonly activity: number;
  /** Its second line: what it is, and its state. */
  readonly detail: string;
  /** A listened-in task's request, as a third line; `null` for everything else. */
  readonly task: string | null;
}

export interface ChatListProps {
  readonly companyId: string;
  readonly selectedAgentId: string | null;
  readonly eavesdrops: readonly Eavesdrop[];
  readonly onSelect: (conversation: Conversation) => void;
  readonly listRef: Ref<HTMLDivElement>;
}

/** Case-insensitive "contains", for the titles the client already has. */
const contains = (text: string | null, query: string): boolean =>
  text !== null && text.toLowerCase().includes(query.toLowerCase());

/**
 * The left pane of the chat dialog: search, the views grouped as Chats,
 * Running and Finished (newest first in each), "Show archived", and Add new.
 *
 * A single-select `ListBox`, so arrow keys move between views and the selected
 * one is announced as selected. Selecting keeps focus here, so a keyboard user
 * can browse views without being thrown into each transcript. Rows re-sort
 * only when a turn starts or ends ({@link useActivityStamps}), and the list
 * keeps focus by key, so a re-sort never moves the user.
 */
export const ChatList = ({
  companyId,
  selectedAgentId,
  eavesdrops,
  onSelect,
  listRef,
}: ChatListProps) => {
  const assignments = useLiveAssignmentsList({ companyId });
  const tasks = useLiveCompanyTasksList(companyId);
  const agents = useLiveCompanyAgentsList(companyId);
  const roles = useCompanyRolesList(companyId);
  const activity = useActivityStamps(agents.data);

  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    const handle = setTimeout(() => {
      setSearched(query.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
    };
  }, [query]);

  const search = useTranscriptSearch(companyId, searched);
  const transcriptMatches = new Set(search.data ?? []);

  const assignmentOf = (agentId: string) =>
    assignments.data?.find((assignment) => assignment.agentId === agentId);
  const taskOf = (taskId: string | null | undefined) =>
    taskId == null ? undefined : tasks.data?.find((task) => task.id === taskId);
  const roleName = (roleId: string) =>
    roles.data?.find((role) => role.id === roleId)?.name ??
    t('activity.role.unknown');
  const stateText = (finished: boolean, chat: boolean): string =>
    t(
      chat
        ? finished
          ? 'chat.list.state.completed'
          : 'chat.list.state.open'
        : finished
          ? 'chat.list.state.finished'
          : 'chat.list.state.running',
    );

  const rows: Row[] = [
    ...(assignments.data ?? []).flatMap((assignment): Row[] => {
      const { agentId } = assignment;
      if (assignment.mode !== 'chat' || typeof agentId !== 'string') return [];
      const finished = isFinished(assignment.status);
      const reference = assignment.shortcode ?? null;
      return [
        {
          conversation: {
            agentId,
            roleName: roleName(assignment.roleId),
            reference,
          },
          group: 'chats',
          // Archiving a chat completes it, so a finished chat is an archived one.
          archived: finished,
          activity: activity(agentId, assignment.updatedAt),
          detail: [
            t('chat.list.kind.chat'),
            t('chat.list.started', {
              time: startedFormatter.format(new Date(assignment.createdAt)),
            }),
            stateText(finished, true),
          ].join(' · '),
          task: null,
        },
      ];
    }),
    ...eavesdrops.map((eavesdrop): Row => {
      const assignment = assignmentOf(eavesdrop.agentId);
      const task = taskOf(assignment?.taskId);
      const finished = isFinished(assignment?.status);
      return {
        conversation: { ...eavesdrop, readOnly: true },
        group: finished ? 'finished' : 'running',
        archived: eavesdrop.archived,
        activity: activity(eavesdrop.agentId, assignment?.updatedAt),
        // What the agent is doing and for which task tells apart rows that
        // share a role; the stored shortcode stands in until the assignment
        // is known.
        detail: (assignment === undefined
          ? [t('chat.list.kind.listening'), eavesdrop.reference]
          : [
              modeLabel(assignment.mode),
              task === undefined
                ? null
                : t('visualisation.tray.taskHeading', {
                    shortcode: task.shortcode,
                  }),
            ]
        )
          .concat(stateText(finished, false))
          .filter(Boolean)
          .join(' · '),
        task: task?.request ?? null,
      };
    }),
  ];

  const visible = rows
    .filter((row) => showArchived || !row.archived)
    .filter(
      (row) =>
        searched === '' ||
        contains(row.conversation.roleName, searched) ||
        contains(row.conversation.reference, searched) ||
        transcriptMatches.has(row.conversation.agentId),
    )
    .sort((a, b) => b.activity - a.activity);

  // Search results are announced once they settle, as a count: the list
  // itself is browsable, and reading every match aloud would be noise.
  const lastAnnounced = useRef<string | null>(null);
  const settled = searched === '' || !search.isFetching;
  useEffect(() => {
    if (!settled || searched === lastAnnounced.current) return;
    lastAnnounced.current = searched;
    if (searched === '') return;
    announce({
      channel: 'chat-search',
      change: 'chat.search.announce',
      params: { count: visible.length },
    });
  }, [settled, searched, visible.length]);

  return (
    <section className="chat-list" aria-label={t('chat.list.label')}>
      <SearchField
        className="react-aria-SearchField chat-list__search"
        value={query}
        onChange={setQuery}
      >
        <Label className="react-aria-Label">{t('chat.search.label')}</Label>
        <Input className="react-aria-Input" />
      </SearchField>

      <ListBox
        ref={listRef}
        className="react-aria-ListBox chat-list__items"
        aria-label={t('chat.dialog.heading')}
        selectionMode="single"
        // Pressing the selected view again must not leave nothing selected.
        disallowEmptySelection
        selectedKeys={selectedAgentId === null ? [] : [selectedAgentId]}
        onSelectionChange={(keys) => {
          if (keys === 'all') return;
          const [key] = [...keys];
          const row = visible.find((r) => r.conversation.agentId === key);
          if (row !== undefined) onSelect(row.conversation);
        }}
        renderEmptyState={() => (
          <p className="chat-list__empty">
            {t(searched === '' ? 'chat.list.empty' : 'chat.list.noMatches')}
          </p>
        )}
      >
        {GROUPS.map(({ id, heading }) => {
          const inGroup = visible.filter((row) => row.group === id);
          // An empty group's heading would be one more stop that says nothing.
          if (inGroup.length === 0) return null;
          return (
            <ListBoxSection key={id} id={id}>
              <Header className="chat-list__group">{t(heading)}</Header>
              {inGroup.map((row) => (
                <ListBoxItem
                  key={row.conversation.agentId}
                  id={row.conversation.agentId}
                  textValue={row.conversation.roleName}
                  className="react-aria-ListBoxItem chat-list__item"
                >
                  <span className="chat-list__icon">
                    <Icon icon={row.group === 'chats' ? MessageCircle : Ear} />
                  </span>
                  <span className="chat-list__text">
                    {/*
                      The role and the detail line name the row, so arrowing
                      through same-role rows reads what sets each apart. The
                      task's request is its description, read after.
                    */}
                    <Text slot="label" className="chat-list__label">
                      <span className="chat-list__title">
                        {row.conversation.roleName}
                      </span>
                      {/* A pause between the two lines, heard not seen. */}
                      <span className="visually-hidden">,</span>{' '}
                      <span className="chat-list__detail">{row.detail}</span>
                    </Text>
                    {row.task !== null && (
                      <Text slot="description" className="chat-list__task">
                        {row.task}
                      </Text>
                    )}
                  </span>
                </ListBoxItem>
              ))}
            </ListBoxSection>
          );
        })}
      </ListBox>

      <div className="chat-list__footer">
        <CheckboxField isSelected={showArchived} onChange={setShowArchived}>
          <CheckboxButton>{t('chat.list.showArchived')}</CheckboxButton>
        </CheckboxField>
        <AddNewMenu companyId={companyId} inChat />
      </div>
    </section>
  );
};
