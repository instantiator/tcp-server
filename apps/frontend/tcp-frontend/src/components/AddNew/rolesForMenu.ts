import type { RoleDTO } from '../../api/dtos';

/**
 * Orders a company's roles for the "New chat" submenu: alphabetically by
 * name, the order a person picking a role by eye expects.
 *
 * Copies rather than sorting in place — `roles` is a query result the cache
 * still owns, and mutating it would corrupt whatever else reads the same
 * array.
 */
export const rolesForMenu = (roles: readonly RoleDTO[]): RoleDTO[] =>
  [...roles].sort((a, b) => a.name.localeCompare(b.name));
