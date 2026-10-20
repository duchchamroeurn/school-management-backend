import { AuditAction, AuditEntityType } from '../constants/audit';
import { Prisma } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { currentContext } from '../lib/requestContext';

type Snapshot = Record<string, unknown>;

export interface AuditEntry<E extends AuditEntityType = AuditEntityType> {
  entityType: E;
  action: AuditAction<E>;
  entityId: string | null;
  entityLabel?: string;
  before?: Snapshot | null;
  after?: Snapshot | null;
  actor?: { id: string; username: string }; // defaults to the signed-in user of the current request
}

export interface ListAuditLogsFilter {
  entityType?: AuditEntityType;
  entityId?: string;
  action?: AuditAction;
  actorUserId?: string;
  from?: Date;
  to?: Date; // exclusive
  skip: number;
  take: number;
}

// Bookkeeping and secrets never go into a snapshot
const OMITTED_FIELDS = new Set(['createdAt', 'updatedAt', 'passwordHash']);

// Plain JSON (Dates become ISO strings) without omitted fields
function clean(snapshot: Snapshot): Snapshot {
  const json = JSON.parse(JSON.stringify(snapshot)) as Snapshot;
  return Object.fromEntries(Object.entries(json).filter(([key]) => !OMITTED_FIELDS.has(key)));
}

/**
 * Top-level scalar fields of a record, for simple snapshots. Drops included relations, _count and id
 * (the entry's entityId already holds it). Pass the names of included relations that may be null.
 */
export function scalars(record: object, relations: string[] = []): Snapshot {
  return Object.fromEntries(
    Object.entries(record).filter(
      ([key, value]) =>
        key !== 'id' && key !== '_count' && !relations.includes(key) && (value === null || value instanceof Date || typeof value !== 'object'),
    ),
  );
}

/**
 * Records one audit entry. Pass the transaction client of the change itself, so the change and its
 * audit entry are committed together or not at all. For updates, give both before and after: only the
 * fields that differ are stored, and an update that changed nothing is not recorded.
 */
export async function audit<E extends AuditEntityType>(db: Prisma.TransactionClient, entry: AuditEntry<E>) {
  const context = currentContext();
  const actor = entry.actor ?? context?.actor;
  let before = entry.before ? clean(entry.before) : null;
  let after = entry.after ? clean(entry.after) : null;

  if (before && after) {
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
      // A field missing on one side counts as null
      (key) => JSON.stringify(before![key] ?? null) !== JSON.stringify(after![key] ?? null),
    );
    if (!changed.length) return;
    before = Object.fromEntries(changed.map((key) => [key, before![key] ?? null]));
    after = Object.fromEntries(changed.map((key) => [key, after![key] ?? null]));
  }

  await db.auditLog.create({
    data: {
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      entityLabel: entry.entityLabel ?? null,
      actorUserId: actor?.id ?? null,
      actorUsername: actor?.username ?? null,
      ipAddress: context?.ip ?? null,
      before: (before as Prisma.InputJsonValue | null) ?? Prisma.DbNull,
      after: (after as Prisma.InputJsonValue | null) ?? Prisma.DbNull,
    },
  });
}

export async function listAuditLogs(filter: ListAuditLogsFilter) {
  const where: Prisma.AuditLogWhereInput = {
    entityType: filter.entityType,
    entityId: filter.entityId,
    action: filter.action,
    actorUserId: filter.actorUserId,
    ...((filter.from || filter.to) && { createdAt: { gte: filter.from, lt: filter.to } }),
  };
  const [items, total] = await prisma.$transaction([
    prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: filter.skip, take: filter.take }),
    prisma.auditLog.count({ where }),
  ]);
  return { items, total };
}
