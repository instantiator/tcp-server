import { useState } from 'react';
import {
  Button,
  CheckboxButton,
  CheckboxField,
  CheckboxGroup,
  Label,
} from 'react-aria-components';
import { useListChangeAnnouncement } from '../../../announce/useListChangeAnnouncement';
import { useLiveCompanyChatsList } from '../../../api/hooks';
import { statusLabel } from '../../../api/statuses';
import { useChat } from '../../../components/ChatDialog/useChat';
import { t } from '../../../strings';
import { ActivityList } from './ActivityList';
import { roleLabel, type ListProps } from './activity-list-utils';

/**
 * The two status options a chat can be filtered by.
 *
 * A chat-mode assignment is created directly `in-progress` (`AgentDbService.create`)
 * and has no plan/QA phase, so "open" is exactly `in-progress` and "completed"
 * is any of the three terminal statuses a `TcpAssignment` can otherwise reach.
 * Written as literals rather than derived from the schema for the same reason
 * `ACTIVE_TASK_STATUSES` and friends are, in `api/statuses.ts`: which statuses
 * count as "open" is a product judgement, not something the type can answer.
 */
const CHAT_STATUS_OPTIONS = ['open', 'completed'] as const;
type ChatStatusOption = (typeof CHAT_STATUS_OPTIONS)[number];

/** Terminal {@link TcpAssignmentStatus} values — what "completed" means for a chat. */
const CHAT_COMPLETED_STATUSES = ['succeeded', 'failed', 'cancelled'];

/** A role, as needed to render one filter checkbox per role. */
interface ChatRole {
  readonly id: string;
  readonly name: string;
}

/**
 * Props for {@link ChatsList}, on top of what every role-labelled list needs.
 *
 * `roles` is bolted on here rather than added to the shared `ListProps`:
 * `AgentsList` and `ConsultationsList` only ever look a role name up by id
 * (`roleLabel`), and widening the shared type would hand them a list they
 * have no use for. This list alone renders one checkbox per role, which needs
 * the roles themselves, not just the id-to-name map.
 */
interface ChatsListProps extends ListProps {
  readonly roles: readonly ChatRole[];
}

/**
 * Matches a chat's status against the selected status options.
 *
 * An empty selection is permissive — it matches every status — per the
 * product rule that a filter with nothing checked narrows nothing. This
 * applies even though the visible default has "open" pre-checked: a user who
 * unchecks both options is asking to see every status, not to see none.
 */
const matchesStatusFilter = (
  status: string,
  selected: readonly string[],
): boolean =>
  selected.length === 0 ||
  selected.some((option: string) =>
    option === 'open'
      ? status === 'in-progress'
      : CHAT_COMPLETED_STATUSES.includes(status),
  );

/**
 * Matches a chat's role against the selected roles.
 *
 * Empty is permissive, same rule as {@link matchesStatusFilter}. Checking more
 * than one role is a union: a chat has exactly one `roleId`, so this asks
 * "does it match any of the selected roles", never "all of them" — the latter
 * would be unsatisfiable for any two distinct roles.
 */
const matchesRoleFilter = (
  roleId: string,
  selected: readonly string[],
): boolean => selected.length === 0 || selected.includes(roleId);

interface ChatFiltersProps {
  readonly statusSelected: string[];
  readonly onStatusChange: (value: string[]) => void;
  readonly roleSelected: string[];
  readonly onRoleChange: (value: string[]) => void;
  readonly roles: readonly ChatRole[];
}

/**
 * The status and role filters over {@link ChatsList} — two independent
 * `CheckboxGroup`s, combined with AND by the caller (a chat must pass both).
 *
 * `CheckboxField` + `CheckboxButton` rather than `Checkbox`, matching
 * `TaskStatusFilter` in `TasksList.tsx`: React Aria 1.20 deprecates `Checkbox`
 * exactly as it deprecates `Radio` (see `ThemeControl`'s note on the same
 * trade for radios), and the pair renders the same shape so `styles/base.css`
 * selects on `.react-aria-CheckboxButton` for both.
 */
const ChatFilters = ({
  statusSelected,
  onStatusChange,
  roleSelected,
  onRoleChange,
  roles,
}: ChatFiltersProps) => (
  <div className="activity-filter">
    {/*
      Passing `className` to a React Aria component replaces its default class
      rather than composing with it, so the library's own class name is
      repeated here — drop it and every rule in `styles/base.css` stops
      applying, silently.
    */}
    <CheckboxGroup
      className="react-aria-CheckboxGroup activity-filter__group"
      value={statusSelected}
      onChange={onStatusChange}
    >
      <Label>{t('activity.chats.filter.status.label')}</Label>
      {CHAT_STATUS_OPTIONS.map((option: ChatStatusOption) => (
        <CheckboxField key={option} value={option}>
          <CheckboxButton>
            {t(`activity.chats.filter.status.${option}`)}
          </CheckboxButton>
        </CheckboxField>
      ))}
    </CheckboxGroup>
    <CheckboxGroup
      className="react-aria-CheckboxGroup activity-filter__group"
      value={roleSelected}
      onChange={onRoleChange}
    >
      <Label>{t('activity.chats.filter.role.label')}</Label>
      {roles.map((role) => (
        <CheckboxField key={role.id} value={role.id}>
          <CheckboxButton>{role.name}</CheckboxButton>
        </CheckboxField>
      ))}
    </CheckboxGroup>
  </div>
);

/**
 * Chats — assignments in `chat` mode. Unlike every other activity list, a
 * finished chat is still worth reading, so there is no status filter that
 * hides completed rows outright — instead {@link ChatFilters} lets the user
 * choose "open", "completed", both or neither, starting on "open" alone.
 *
 * **Rows are interactive**, the one list in this view where that is true:
 * each opens the chat dialog on the agent it names. Every other list here has
 * no dialog yet to open.
 */
export const ChatsList = ({
  companyId,
  roleNames,
  roles,
  onCount,
}: ChatsListProps) => {
  const query = useLiveCompanyChatsList(companyId);
  const { openChat } = useChat();

  const [statusSelected, setStatusSelected] = useState<string[]>(['open']);
  const [roleSelected, setRoleSelected] = useState<string[]>([]);

  // A chat assignment with no `agentId` has no agent to open — the two are
  // created together, so this is not expected to happen, but a row whose
  // button cannot do anything is worse than no row. Filtered before the
  // status/role filters and before counting, so the count shown and the rows
  // rendered always agree.
  const rows = query.data
    ?.filter(
      (assignment): assignment is typeof assignment & { agentId: string } =>
        assignment.agentId !== undefined,
    )
    .filter((assignment) =>
      matchesStatusFilter(assignment.status, statusSelected),
    )
    .filter((assignment) => matchesRoleFilter(assignment.roleId, roleSelected));

  useListChangeAnnouncement(
    rows?.map((assignment) => assignment.id),
    {
      channel: 'chats',
      added: 'announce.chatsStarted',
      removed: 'announce.chatsEnded',
      // Reseeds the hook when either filter changes, so narrowing one does not
      // read as a mass arrival or departure of chats — the user did that, they
      // are looking at it, and announcing it would describe their own
      // keystroke back to them. Same reasoning, same mechanism, as
      // `TaskStatusFilter`'s `resetKey` in `TasksList.tsx`.
      resetKey: `${statusSelected.join(' ')}|${roleSelected.join(' ')}`,
    },
  );

  return (
    <ActivityList
      onCount={onCount}
      heading={t('activity.chats.heading')}
      query={query}
      channel="chats"
      count={rows?.length ?? 0}
      emptyHeading={t('activity.chats.empty.heading')}
      emptyBody={t('activity.chats.empty.body')}
      // Inside the region, above the rows: the filters belong to this list,
      // and rendering them as a sibling would leave that relationship to
      // proximity alone. Outside the busy area — a control over the content
      // is not part of it, and must not be replaced by the spinner.
      controls={
        <ChatFilters
          statusSelected={statusSelected}
          onStatusChange={setStatusSelected}
          roleSelected={roleSelected}
          onRoleChange={setRoleSelected}
          roles={roles}
        />
      }
    >
      <ul className="activity-list__rows">
        {rows?.map((assignment) => {
          const role = roleLabel(roleNames, assignment.roleId);
          return (
            <li className="activity-list__row" key={assignment.id}>
              {/*
                The button is the row's title, and its visible text is its
                whole accessible name — no `aria-label`. A `<button>` may only
                hold phrasing content, so the two-paragraph shape the other
                lists use cannot go inside one; and a name that says what
                pressing it does keeps every row in this list distinct from
                the plain role name the other lists show.
              */}
              <Button
                className="react-aria-Button activity-list__row-title"
                onPress={() => {
                  openChat({
                    agentId: assignment.agentId,
                    roleName: role,
                    reference: assignment.shortcode ?? null,
                  });
                }}
              >
                {t('activity.chats.open', { role })}
              </Button>
              <p className="activity-list__row-detail">
                {statusLabel(assignment.status)}
              </p>
            </li>
          );
        })}
      </ul>
    </ActivityList>
  );
};
