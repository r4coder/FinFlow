import { Role } from '@prisma/client';
import { Db, prisma } from '../db';

export interface NotifyInput {
  organizationId: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  invoiceId?: string | null;
  /** Same dedupeKey for the same user => notification created at most once (idempotent jobs). */
  dedupeKey: string;
}

export async function notifyUser(input: NotifyInput, db: Db = prisma): Promise<boolean> {
  const res = await db.notification.createMany({
    data: [
      {
        organizationId: input.organizationId,
        userId: input.userId,
        type: input.type,
        title: input.title,
        message: input.message,
        invoiceId: input.invoiceId ?? null,
        dedupeKey: input.dedupeKey,
      },
    ],
    skipDuplicates: true,
  });
  return res.count > 0;
}

/** All users in the org holding exactly this role; falls back to ADMIN/OWNER if none. */
export async function usersWithRole(organizationId: string, role: Role, db: Db = prisma): Promise<string[]> {
  const order: Role[] = [role, 'ADMIN', 'OWNER'];
  for (const r of order) {
    const members = await db.organizationMember.findMany({ where: { organizationId, role: r }, select: { userId: true } });
    if (members.length) return members.map((m) => m.userId);
  }
  return [];
}

export type RecipientSpec = 'UPLOADER' | 'FINANCE_MANAGER' | 'ADMIN' | 'OWNER' | 'USER';

export async function resolveRecipients(
  organizationId: string,
  spec: RecipientSpec,
  opts: { uploaderId?: string | null; userId?: string | null },
  db: Db = prisma,
): Promise<string[]> {
  switch (spec) {
    case 'UPLOADER':
      return opts.uploaderId ? [opts.uploaderId] : usersWithRole(organizationId, 'ADMIN', db);
    case 'USER': {
      if (!opts.userId) return [];
      const m = await db.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId, userId: opts.userId } },
      });
      return m ? [opts.userId] : []; // never notify a user outside the org
    }
    default:
      return usersWithRole(organizationId, spec as Role, db);
  }
}

/** Replace {{variables}} in a template. Unknown variables are left empty. */
export function renderTemplate(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => String(vars[k] ?? ''));
}
