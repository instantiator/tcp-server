import { shortened } from '../../../../components/ExpandableText/excerpt';
import { t } from '../../../../strings';
import type { CompanySnapshot } from '../rules/companySnapshot';
import type { Furniture, OfficeWorld, Room } from '../world/types';
import { avatarById, roomById } from '../world/worldOps';

/** What a piece of furniture or a room is, in words: a title, and what it's for. */
export interface OfficeDescription {
  readonly title: string;
  /** Absent where the title says it all (a whiteboard opens its task instead). */
  readonly description?: string;
  /** A further line below the description (a task room shows its task's request). */
  readonly detail?: string;
}

const ONE_TO_ONE_PREFIX = 'oneToOne:';

function roleName(snapshot: CompanySnapshot, roleId: string): string {
  return (
    snapshot.roles.find((role) => role.id === roleId)?.name ??
    t('activity.role.unknown')
  );
}

/** A piece of furniture's title and purpose. A desk is named after its owner's role. */
export function describeFurniture(
  item: Furniture,
  world: OfficeWorld,
  snapshot: CompanySnapshot,
): OfficeDescription {
  switch (item.kind) {
    case 'desk': {
      const owner =
        item.ownerAvatarId === undefined
          ? undefined
          : avatarById(world, item.ownerAvatarId);
      return {
        title:
          owner === undefined
            ? t('visualisation.furniture.deskUnowned')
            : t('visualisation.furniture.desk', {
                role: roleName(snapshot, owner.roleId),
              }),
        description: t('visualisation.furniture.desk.description'),
      };
    }
    case 'whiteboard':
      return { title: t('visualisation.furniture.whiteboard') };
    case 'bookshelf':
      return {
        title: t('visualisation.furniture.bookshelf', {
          count: snapshot.tasks.filter((task) => task.succeeded).length,
        }),
        description: t('visualisation.furniture.bookshelf.description'),
      };
    case 'sofa':
    case 'pigeonholes':
    case 'table':
    case 'officeDoor':
      return {
        title: t(`visualisation.furniture.${item.kind}`),
        description: t(`visualisation.furniture.${item.kind}.description`),
      };
  }
}

/**
 * A room's title and purpose. A 1:1 room names the two roles consulting in
 * it, read from the snapshot agents keyed to it; once either has gone, it
 * says "two agents" instead. The corridor isn't described.
 */
export function describeRoom(
  room: Room,
  snapshot: CompanySnapshot,
): OfficeDescription | null {
  switch (room.purpose) {
    case 'corridor':
      return null;
    case 'rec':
    case 'mail':
    case 'archive':
      return {
        title: t(`visualisation.room.${room.purpose}`),
        description: t(`visualisation.room.${room.purpose}.description`),
      };
    case 'task': {
      const task = snapshot.tasks.find(
        (candidate) => candidate.id === room.taskId,
      );
      const shortcode = task?.shortcode ?? '';
      return {
        title: t('visualisation.room.task', { shortcode }),
        description: t('visualisation.room.task.description', { shortcode }),
        ...(task === undefined ? {} : { detail: shortened(task.request) }),
      };
    }
    case 'oneToOne': {
      const oneToOneId = room.id.slice(ONE_TO_ONE_PREFIX.length);
      const roles = snapshot.agents
        .filter(
          (agent) =>
            agent.activity.kind === 'consulting' &&
            agent.activity.oneToOneId === oneToOneId,
        )
        .map((agent) => roleName(snapshot, agent.roleId));
      const [roleA, roleB] = roles;
      return {
        title: t('visualisation.room.oneToOne'),
        description:
          roleA === undefined || roleB === undefined
            ? t('visualisation.room.oneToOne.descriptionUnknown')
            : t('visualisation.room.oneToOne.description', { roleA, roleB }),
      };
    }
  }
}

/** Looks up and describes a furniture or room hover target. `null` for an id that has gone. */
export function describeTarget(
  target: { readonly kind: 'furniture' | 'room'; readonly id: string },
  world: OfficeWorld,
  snapshot: CompanySnapshot,
): OfficeDescription | null {
  if (target.kind === 'room') {
    const room = roomById(world, target.id);
    return room === undefined ? null : describeRoom(room, snapshot);
  }
  const item = world.furniture.find((candidate) => candidate.id === target.id);
  return item === undefined ? null : describeFurniture(item, world, snapshot);
}
