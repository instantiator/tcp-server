import type { StringKey } from '../../strings';

/** The Admin tab's sections, in menu order. Each id is also its URL hash path (`#admin/users`). */
export const ADMIN_SECTIONS = [
  { id: 'roles', label: 'admin.menu.roles' },
  { id: 'users', label: 'admin.menu.users' },
  { id: 'knowledge', label: 'admin.menu.knowledge' },
  { id: 'data-protection', label: 'admin.menu.dataProtection' },
] as const satisfies readonly { id: string; label: StringKey }[];

export type AdminSection = (typeof ADMIN_SECTIONS)[number]['id'];

/** Narrows a hash path segment to a section, so an unknown one can fall back. */
export const isAdminSection = (key: string): key is AdminSection =>
  ADMIN_SECTIONS.some((section) => section.id === key);
