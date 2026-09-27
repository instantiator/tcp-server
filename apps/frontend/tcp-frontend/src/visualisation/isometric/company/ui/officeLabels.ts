import { t } from '../../../../strings';
import type { AgentActivity, CompanySnapshot } from '../rules/companySnapshot';
import type { OfficeLabel } from '../TcpPhaserEventBus';
import type { OfficeWorld } from '../world/types';
import { describeFurniture, describeRoom } from './officeDescriptions';

/** The kinds of label the office view can show, each behind its own checkbox. */
export const LABEL_KINDS = ['agents', 'roles', 'furniture', 'rooms'] as const;
export type LabelKind = (typeof LABEL_KINDS)[number];

/** Which kinds of label are on. Empty — all off — by default. */
export type LabelToggles = readonly LabelKind[];

function roleName(snapshot: CompanySnapshot, roleId: string): string {
  return (
    snapshot.roles.find((role) => role.id === roleId)?.name ??
    t('activity.role.unknown')
  );
}

/** What an agent is doing, in the words its label uses. */
function activityWords(activity: AgentActivity | undefined): string {
  return t(`visualisation.activity.${activity?.kind ?? 'waiting'}`);
}

/**
 * The labels to draw for the kinds switched on in `toggles`. Pure: the
 * scene only places the text, so every name and string is worked out here.
 * An agent avatar whose agent has finished reads as waiting, since it is
 * sitting at its desk for the next agent of its role.
 */
export function buildOfficeLabels(
  world: OfficeWorld,
  snapshot: CompanySnapshot | null,
  toggles: LabelToggles,
): OfficeLabel[] {
  if (snapshot === null || toggles.length === 0) {
    return [];
  }
  const on = new Set(toggles);
  const labels: OfficeLabel[] = [];

  for (const avatar of world.avatars) {
    const anchor = { kind: 'avatar', avatarId: avatar.id } as const;
    const role = roleName(snapshot, avatar.roleId);
    if (avatar.kind === 'role' && on.has('roles')) {
      labels.push({
        id: `avatar:${avatar.id}`,
        text: t('visualisation.label.role', { role }),
        anchor,
      });
    }
    if (avatar.kind === 'agent' && on.has('agents')) {
      const agent = snapshot.agents.find(
        (candidate) => candidate.id === avatar.agentId,
      );
      labels.push({
        id: `avatar:${avatar.id}`,
        text: t('visualisation.label.agent', {
          role,
          activity: activityWords(agent?.activity),
        }),
        anchor,
      });
    }
  }

  if (on.has('furniture')) {
    for (const item of world.furniture) {
      labels.push({
        id: `furniture:${item.id}`,
        text: describeFurniture(item, world, snapshot).title,
        anchor: { kind: 'tile', tile: item.tile },
      });
    }
  }

  if (on.has('rooms')) {
    for (const room of world.rooms) {
      const described = describeRoom(room, snapshot);
      if (room.door === null || described === null) {
        continue;
      }
      labels.push({
        id: `room:${room.id}`,
        text: described.title,
        anchor: { kind: 'tile', tile: room.door },
      });
    }
  }

  return labels;
}
