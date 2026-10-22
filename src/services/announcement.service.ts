// Announcements (ការជូនដំណឹង): notices from the school to everyone, to chosen roles, or to chosen classes.
//
// Who sees an announcement, from publishAt until expiresAt:
//   EVERYONE  every signed-in user
//   ROLES     logins holding any of its roles
//   CLASSES   enrolled students of its classes, and those classes' homeroom and subject teachers
// The same rules decide the feed (one user) and the recipient count (everyone), so the two always agree.
import { Errors } from '../constants/errors';
import { AnnouncementAudience, AnnouncementPriority, Prisma, StudentStatus, UserStatus } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { audit } from './audit.service';

export interface AnnouncementInput {
  title: string;
  body: string;
  priority?: AnnouncementPriority;
  pinned?: boolean;
  audience: AnnouncementAudience;
  roleIds?: string[]; // audience ROLES
  classSectionIds?: string[]; // audience CLASSES
  publishAt?: Date; // default: now
  expiresAt?: Date | null;
}

export type AnnouncementStatus = 'SCHEDULED' | 'ACTIVE' | 'EXPIRED';

export interface ListAnnouncementsFilter {
  status?: AnnouncementStatus;
  skip: number;
  take: number;
}

const details = {
  author: {
    select: {
      username: true,
      staffProfile: { select: { khmerName: true, latinName: true } },
    },
  },
  roles: { select: { role: { select: { id: true, khmerName: true, latinName: true } } } },
  classes: {
    select: {
      classSection: { select: { id: true, sectionName: true, grade: { select: { gradeNumber: true } }, academicYear: { select: { name: true } } } },
    },
  },
} satisfies Prisma.AnnouncementInclude;

type AnnouncementWithDetails = Prisma.AnnouncementGetPayload<{ include: typeof details }>;

const toDto = ({ author, roles, classes, authorId: _authorId, ...a }: AnnouncementWithDetails) => ({
  ...a,
  author: author && { username: author.username, khmerName: author.staffProfile?.khmerName ?? null, latinName: author.staffProfile?.latinName ?? null },
  roles: roles.map((r) => r.role),
  classes: classes
    .map(({ classSection: c }) => ({ id: c.id, name: `${c.grade.gradeNumber}${c.sectionName}`, academicYear: c.academicYear.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true })),
});

// Pinned first, then important, then newest. IMPORTANT sorts after NORMAL in the enum, so descending puts it first.
const feedOrder: Prisma.AnnouncementOrderByWithRelationInput[] = [{ pinned: 'desc' }, { priority: 'desc' }, { publishAt: 'desc' }];

const published = (now: Date): Prisma.AnnouncementWhereInput => ({
  publishAt: { lte: now },
  OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
});

/** Announcements whose audience includes this user (regardless of dates). */
function forUser(userId: string): Prisma.AnnouncementWhereInput {
  return {
    OR: [
      { audience: AnnouncementAudience.EVERYONE },
      { audience: AnnouncementAudience.ROLES, roles: { some: { role: { userRoles: { some: { userId } } } } } },
      {
        audience: AnnouncementAudience.CLASSES,
        classes: {
          some: {
            classSection: {
              OR: [
                { enrollments: { some: { student: { userId, status: StudentStatus.ENROLLED } } } },
                { homeroomTeacher: { userId } },
                { subjectTeacherAssignments: { some: { staffProfile: { userId } } } },
              ],
            },
          },
        },
      },
    ],
  };
}

/** What the user may read now: published, not expired, and for them. */
const visibleTo = (userId: string, now = new Date()): Prisma.AnnouncementWhereInput => ({ AND: [published(now), forUser(userId)] });

/** Active logins the announcement is for: the same rules as forUser, counted across all users. */
function recipientCount(a: { audience: AnnouncementAudience; roles: { role: { id: string } }[]; classes: { classSection: { id: string } }[] }) {
  const active = { status: UserStatus.ACTIVE };
  if (a.audience === AnnouncementAudience.EVERYONE) return prisma.user.count({ where: active });
  if (a.audience === AnnouncementAudience.ROLES) {
    return prisma.user.count({ where: { ...active, userRoles: { some: { roleId: { in: a.roles.map((r) => r.role.id) } } } } });
  }
  const classIds = a.classes.map((c) => c.classSection.id);
  return prisma.user.count({
    where: {
      ...active,
      OR: [
        { studentProfile: { status: StudentStatus.ENROLLED, enrollments: { some: { classSectionId: { in: classIds } } } } },
        { staffProfile: { homeroomClasses: { some: { id: { in: classIds } } } } },
        { staffProfile: { subjectTeacherAssignments: { some: { classSectionId: { in: classIds } } } } },
      ],
    },
  });
}

function statusOf(a: { publishAt: Date; expiresAt: Date | null }, now = new Date()): AnnouncementStatus {
  if (a.publishAt > now) return 'SCHEDULED';
  return a.expiresAt && a.expiresAt <= now ? 'EXPIRED' : 'ACTIVE';
}

// ── Reading ──────────────────────────────────────────────────────────────

/** The user's announcements, with whether they have read each. */
export async function listFeed(userId: string, page: { skip: number; take: number }) {
  const where = visibleTo(userId);
  const [items, total] = await prisma.$transaction([
    prisma.announcement.findMany({
      where,
      include: { ...details, reads: { where: { userId }, select: { readAt: true } } },
      orderBy: feedOrder,
      skip: page.skip,
      take: page.take,
    }),
    prisma.announcement.count({ where }),
  ]);
  return { items: items.map(({ reads, ...a }) => ({ ...toDto(a), read: reads.length > 0 })), total };
}

export function countUnread(userId: string) {
  return prisma.announcement.count({ where: { AND: [visibleTo(userId), { reads: { none: { userId } } }] } });
}

/** One announcement, for a user it is for, or anyone with MANAGE_ANNOUNCEMENTS (who also sees drafts and old ones). */
export async function getAnnouncement(id: string, viewer: { userId: string; canManage: boolean }) {
  const where: Prisma.AnnouncementWhereInput = viewer.canManage ? { id } : { AND: [{ id }, visibleTo(viewer.userId)] };
  const announcement = await prisma.announcement.findFirst({
    where,
    include: { ...details, reads: { where: { userId: viewer.userId }, select: { readAt: true } } },
  });
  if (!announcement) throw Errors.ANNOUNCEMENT_NOT_FOUND();
  const { reads, ...a } = announcement;
  return { ...toDto(a), read: reads.length > 0 };
}

/** Marks one announcement read (only one the user can see), once. */
export async function markRead(userId: string, id: string) {
  const visible = await prisma.announcement.findFirst({ where: { AND: [{ id }, visibleTo(userId)] }, select: { id: true } });
  if (!visible) throw Errors.ANNOUNCEMENT_NOT_FOUND();
  await prisma.announcementRead.upsert({
    where: { announcementId_userId: { announcementId: id, userId } },
    update: {},
    create: { announcementId: id, userId },
  });
}

export async function markAllRead(userId: string) {
  const unread = await prisma.announcement.findMany({
    where: { AND: [visibleTo(userId), { reads: { none: { userId } } }] },
    select: { id: true },
  });
  const result = await prisma.announcementRead.createMany({
    data: unread.map((a) => ({ announcementId: a.id, userId })),
    skipDuplicates: true,
  });
  return { marked: result.count };
}

// ── Managing ─────────────────────────────────────────────────────────────

/** Every announcement, newest first, with its status, how many it is for and how many have read it. */
export async function listAll(filter: ListAnnouncementsFilter) {
  const now = new Date();
  const statusWhere: Record<AnnouncementStatus, Prisma.AnnouncementWhereInput> = {
    SCHEDULED: { publishAt: { gt: now } },
    ACTIVE: published(now),
    EXPIRED: { expiresAt: { lte: now } },
  };
  const where = filter.status ? statusWhere[filter.status] : {};
  const [items, total] = await prisma.$transaction([
    prisma.announcement.findMany({
      where,
      include: { ...details, _count: { select: { reads: true } } },
      orderBy: { publishAt: 'desc' },
      skip: filter.skip,
      take: filter.take,
    }),
    prisma.announcement.count({ where }),
  ]);
  const rows = await Promise.all(
    items.map(async ({ _count, ...a }) => ({
      ...toDto(a),
      status: statusOf(a, now),
      readCount: _count.reads,
      recipients: await recipientCount(a),
    })),
  );
  return { items: rows, total };
}

/** Checks the audience and dates; returns the role and class ids to store (only those of the audience). */
async function checkInput(tx: Prisma.TransactionClient, input: AnnouncementInput, publishAt: Date) {
  if (input.expiresAt && input.expiresAt <= publishAt) throw Errors.ANNOUNCEMENT_DATES_INVALID();

  if (input.audience === AnnouncementAudience.ROLES) {
    const ids = [...new Set(input.roleIds ?? [])];
    if (!ids.length) throw Errors.ANNOUNCEMENT_AUDIENCE_EMPTY('roleIds');
    const found = new Set((await tx.role.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw Errors.ANNOUNCEMENT_TARGETS_NOT_FOUND('roleIds', missing);
    return { roleIds: ids, classSectionIds: [] };
  }
  if (input.audience === AnnouncementAudience.CLASSES) {
    const ids = [...new Set(input.classSectionIds ?? [])];
    if (!ids.length) throw Errors.ANNOUNCEMENT_AUDIENCE_EMPTY('classSectionIds');
    const found = new Set((await tx.classSection.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((c) => c.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw Errors.ANNOUNCEMENT_TARGETS_NOT_FOUND('classSectionIds', missing);
    return { roleIds: [], classSectionIds: ids };
  }
  return { roleIds: [], classSectionIds: [] };
}

const snapshot = (a: AnnouncementWithDetails) => ({
  title: a.title,
  body: a.body,
  priority: a.priority,
  pinned: a.pinned,
  audience: a.audience,
  roleIds: a.roles.map((r) => r.role.id).sort(),
  classSectionIds: a.classes.map((c) => c.classSection.id).sort(),
  publishAt: a.publishAt,
  expiresAt: a.expiresAt,
});

const auditAnnouncement = (a: { id: string; title: string }) => ({ entityType: 'Announcement', entityId: a.id, entityLabel: a.title }) as const;

export async function createAnnouncement(authorId: string, input: AnnouncementInput) {
  return prisma.$transaction(async (tx) => {
    const publishAt = input.publishAt ?? new Date();
    const targets = await checkInput(tx, input, publishAt);
    const created = await tx.announcement.create({
      data: {
        title: input.title,
        body: input.body,
        priority: input.priority ?? AnnouncementPriority.NORMAL,
        pinned: input.pinned ?? false,
        audience: input.audience,
        publishAt,
        expiresAt: input.expiresAt ?? null,
        authorId,
        roles: { create: targets.roleIds.map((roleId) => ({ roleId })) },
        classes: { create: targets.classSectionIds.map((classSectionId) => ({ classSectionId })) },
      },
      include: details,
    });
    await audit(tx, { ...auditAnnouncement(created), action: 'ANNOUNCEMENT_CREATED', after: snapshot(created) });
    return toDto(created);
  });
}

/** Changes any part. Sending audience replaces the targets; reads are kept (the text may have changed only a little). */
export async function updateAnnouncement(id: string, input: Partial<AnnouncementInput>) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.announcement.findUnique({ where: { id }, include: details });
    if (!current) throw Errors.ANNOUNCEMENT_NOT_FOUND();

    const merged: AnnouncementInput = {
      title: input.title ?? current.title,
      body: input.body ?? current.body,
      audience: input.audience ?? current.audience,
      roleIds: input.roleIds ?? current.roles.map((r) => r.role.id),
      classSectionIds: input.classSectionIds ?? current.classes.map((c) => c.classSection.id),
      expiresAt: input.expiresAt === undefined ? current.expiresAt : input.expiresAt,
    };
    const publishAt = input.publishAt ?? current.publishAt;
    const targets = await checkInput(tx, merged, publishAt);

    await tx.announcementRole.deleteMany({ where: { announcementId: id } });
    await tx.announcementClass.deleteMany({ where: { announcementId: id } });
    const updated = await tx.announcement.update({
      where: { id },
      data: {
        title: merged.title,
        body: merged.body,
        priority: input.priority,
        pinned: input.pinned,
        audience: merged.audience,
        publishAt,
        expiresAt: merged.expiresAt,
        roles: { create: targets.roleIds.map((roleId) => ({ roleId })) },
        classes: { create: targets.classSectionIds.map((classSectionId) => ({ classSectionId })) },
      },
      include: details,
    });
    await audit(tx, { ...auditAnnouncement(updated), action: 'ANNOUNCEMENT_UPDATED', before: snapshot(current), after: snapshot(updated) });
    return toDto(updated);
  });
}

export async function deleteAnnouncement(id: string) {
  await prisma.$transaction(async (tx) => {
    const current = await tx.announcement.findUnique({ where: { id }, include: details });
    if (!current) throw Errors.ANNOUNCEMENT_NOT_FOUND();
    await tx.announcement.delete({ where: { id } });
    await audit(tx, { ...auditAnnouncement(current), action: 'ANNOUNCEMENT_DELETED', before: snapshot(current) });
  });
}
