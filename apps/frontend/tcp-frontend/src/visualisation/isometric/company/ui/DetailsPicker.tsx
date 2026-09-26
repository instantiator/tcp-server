import { useMemo } from 'react';
import {
  Button,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  SelectValue,
  type Key,
} from 'react-aria-components';
import { t } from '../../../../strings';
import type { CompanySnapshot } from '../rules/companySnapshot';
import type { SelectionTarget } from '../TcpPhaserEventBus';

export interface DetailsPickerProps {
  readonly snapshot: CompanySnapshot | null;
  readonly selection: SelectionTarget | null;
  readonly onSelect: (target: SelectionTarget) => void;
}

/** One flattened row in the picker: its key, its label, and what choosing it selects. */
interface PickerItem {
  readonly key: string;
  readonly label: string;
  readonly target: SelectionTarget;
}

/** Every role, every unfinished task, then every agent still doing something. */
const buildItems = (snapshot: CompanySnapshot): readonly PickerItem[] => {
  const roleName = (roleId: string): string =>
    snapshot.roles.find((role) => role.id === roleId)?.name ??
    t('activity.role.unknown');

  const taskShortcode = (taskId: string): string | undefined =>
    snapshot.tasks.find((task) => task.id === taskId)?.shortcode;

  const roleItems: PickerItem[] = snapshot.roles.map((role) => ({
    key: `role:${role.id}`,
    label: t('visualisation.picker.role', { name: role.name }),
    target: { kind: 'role', id: role.id },
  }));

  const taskItems: PickerItem[] = snapshot.tasks
    .filter((task) => !task.finished)
    .map((task) => ({
      key: `task:${task.id}`,
      label: t('visualisation.picker.task', { shortcode: task.shortcode }),
      target: { kind: 'task', id: task.id },
    }));

  const agentItems: PickerItem[] = snapshot.agents
    .filter((agent) => agent.activity.kind !== 'finished')
    .map((agent) => {
      const role = roleName(agent.roleId);
      const shortcode =
        agent.taskId === null ? undefined : taskShortcode(agent.taskId);
      return {
        key: `agent:${agent.id}`,
        label:
          shortcode === undefined
            ? t('visualisation.picker.agent', { role })
            : t('visualisation.picker.agentWithTask', { role, shortcode }),
        target: { kind: 'agent', id: agent.id },
      };
    });

  return [...roleItems, ...taskItems, ...agentItems];
};

/**
 * The keyboard route into the tray (ADR-026/027: a pointer-only hover-and-
 * click scene fails WCAG 2.1.1). Lists every role, every unfinished task and
 * every agent still doing something, flat, in that order — choosing one
 * opens the tray on it the same way clicking the office would.
 *
 * Disabled with no snapshot or no items, rather than shown empty: an
 * unusable control that looks usable is worse than one plainly turned off.
 */
export const DetailsPicker = ({
  snapshot,
  selection,
  onSelect,
}: DetailsPickerProps) => {
  const items = useMemo(
    () => (snapshot === null ? [] : buildItems(snapshot)),
    [snapshot],
  );
  const itemByKey = useMemo(
    () => new Map(items.map((item) => [item.key, item])),
    [items],
  );

  const value: Key | null =
    selection === null ? null : `${selection.kind}:${selection.id}`;

  return (
    <Select
      value={value}
      onChange={(key) => {
        if (key === null) return;
        const item = itemByKey.get(String(key));
        if (item !== undefined) onSelect(item.target);
      }}
      isDisabled={snapshot === null || items.length === 0}
      placeholder={t('visualisation.picker.placeholder')}
    >
      <Label>{t('visualisation.picker.label')}</Label>
      <Button>
        <SelectValue />
      </Button>
      <Popover>
        <ListBox>
          {items.map((item) => (
            <ListBoxItem key={item.key} id={item.key}>
              {item.label}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </Select>
  );
};
