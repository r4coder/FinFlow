import { Role } from '@prisma/client';

export type Permission =
  | 'invoice:read'
  | 'invoice:write'
  | 'invoice:approve'
  | 'vendor:write'
  | 'rule:read'
  | 'rule:write'
  | 'analytics:read'
  | 'audit:read'
  | 'settings:ai'
  | 'users:manage';

const ALL: Role[] = ['OWNER', 'ADMIN', 'FINANCE_MANAGER', 'FINANCE_USER', 'VIEWER'];

export const PERMISSIONS: Record<Permission, Role[]> = {
  'invoice:read': ALL,
  'invoice:write': ['OWNER', 'ADMIN', 'FINANCE_MANAGER', 'FINANCE_USER'],
  'invoice:approve': ['OWNER', 'ADMIN', 'FINANCE_MANAGER'],
  'vendor:write': ['OWNER', 'ADMIN', 'FINANCE_MANAGER', 'FINANCE_USER'],
  'rule:read': ALL,
  'rule:write': ['OWNER', 'ADMIN', 'FINANCE_MANAGER'],
  'analytics:read': ALL,
  'audit:read': ['OWNER', 'ADMIN', 'FINANCE_MANAGER'],
  'settings:ai': ['OWNER', 'ADMIN'],
  'users:manage': ['OWNER', 'ADMIN'],
};

export const ROLE_RANK: Record<Role, number> = {
  OWNER: 5,
  ADMIN: 4,
  FINANCE_MANAGER: 3,
  FINANCE_USER: 2,
  VIEWER: 1,
};

export const can = (role: Role, p: Permission) => PERMISSIONS[p].includes(role);
/** Does `actual` satisfy a "requires at least `required`" approval role? */
export const satisfiesRole = (actual: Role, required: Role) => ROLE_RANK[actual] >= ROLE_RANK[required];
