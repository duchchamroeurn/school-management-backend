// Parents and guardians. A Guardian is one person; StudentGuardian links them to each of their children with the
// relationship and whether they are that child's primary contact (at most one per student, kept here).
import { Errors } from '../constants/errors';
import { GuardianRelationship, Prisma } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { audit, scalars } from './audit.service';

export interface GuardianInput {
  khmerName: string;
  latinName: string;
  phone?: string | null;
  telegramHandle?: string | null;
  occupation?: string | null;
  address?: string | null;
}

export interface ListGuardiansFilter {
  search?: string; // Khmer or Latin name, or phone number
  skip: number;
  take: number;
}

export interface LinkGuardianInput {
  guardianId?: string; // link an existing guardian (e.g. a sibling's parent) …
  guardian?: GuardianInput; // … or add a new one
  relationship: GuardianRelationship;
  isPrimaryContact?: boolean; // the student's first guardian is always primary
}

export const MAX_GUARDIANS_PER_STUDENT = 5;

const withStudents = {
  students: {
    include: { student: { select: { id: true, studentIdentifier: true, khmerName: true, latinName: true, status: true } } },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.GuardianInclude;

// A student's guardians, primary contact first
export const studentGuardiansInclude = {
  include: { guardian: true },
  orderBy: [{ isPrimaryContact: 'desc' }, { createdAt: 'asc' }],
} satisfies Prisma.StudentProfile$guardiansArgs;

const auditGuardian = (g: { id: string; khmerName: string; latinName: string }) =>
  ({ entityType: 'Guardian', entityId: g.id, entityLabel: `${g.latinName} (${g.khmerName})` }) as const;
const auditStudent = (s: { id: string; studentIdentifier: string; latinName: string }) =>
  ({ entityType: 'Student', entityId: s.id, entityLabel: `${s.studentIdentifier} ${s.latinName}` }) as const;
const linkSnapshot = (link: { relationship: GuardianRelationship; isPrimaryContact: boolean }, guardian: { id: string; khmerName: string; latinName: string }) => ({
  guardianId: guardian.id,
  guardian: `${guardian.latinName} (${guardian.khmerName})`,
  relationship: link.relationship,
  isPrimaryContact: link.isPrimaryContact,
});

async function loadGuardian(db: Prisma.TransactionClient, id: string) {
  const guardian = await db.guardian.findUnique({ where: { id }, include: withStudents });
  if (!guardian) throw Errors.GUARDIAN_NOT_FOUND();
  return guardian;
}

async function loadStudent(db: Prisma.TransactionClient, id: string) {
  const student = await db.studentProfile.findUnique({ where: { id } });
  if (!student) throw Errors.STUDENT_NOT_FOUND();
  return student;
}

// ── Guardians ─────────────────────────────────────────────────────────────

export async function listGuardians(filter: ListGuardiansFilter) {
  const digits = filter.search?.replace(/[\s\-().]/g, '').replace(/^\+?855/, '0');
  const where: Prisma.GuardianWhereInput = filter.search
    ? {
        OR: [
          { khmerName: { contains: filter.search } },
          { latinName: { contains: filter.search, mode: 'insensitive' } },
          ...(digits && /^\d{3,}$/.test(digits) ? [{ phone: { contains: digits } }] : []),
        ],
      }
    : {};
  const [items, total] = await prisma.$transaction([
    prisma.guardian.findMany({ where, include: withStudents, orderBy: { khmerName: 'asc' }, skip: filter.skip, take: filter.take }),
    prisma.guardian.count({ where }),
  ]);
  return { items, total };
}

export const getGuardian = (id: string) => loadGuardian(prisma, id);

export async function createGuardian(data: GuardianInput) {
  return prisma.$transaction(async (tx) => {
    const created = await tx.guardian.create({ data, include: withStudents });
    await audit(tx, { ...auditGuardian(created), action: 'GUARDIAN_CREATED', after: scalars(created) });
    return created;
  });
}

/** Contact details change once for every child of this guardian */
export async function updateGuardian(id: string, data: Partial<GuardianInput>) {
  return prisma.$transaction(async (tx) => {
    const current = await loadGuardian(tx, id);
    const updated = await tx.guardian.update({ where: { id }, data, include: withStudents });
    await audit(tx, { ...auditGuardian(updated), action: 'GUARDIAN_UPDATED', before: scalars(current), after: scalars(updated) });
    return updated;
  });
}

// Only a guardian with no children linked (e.g. entered by mistake) can be deleted
export async function deleteGuardian(id: string) {
  await prisma.$transaction(async (tx) => {
    const guardian = await loadGuardian(tx, id);
    if (guardian.students.length) throw Errors.GUARDIAN_HAS_STUDENTS(guardian.latinName, guardian.students.length);
    await tx.guardian.delete({ where: { id } });
    await audit(tx, { ...auditGuardian(guardian), action: 'GUARDIAN_DELETED', before: scalars(guardian) });
  });
}

// ── A student's guardians ─────────────────────────────────────────────────

export async function listStudentGuardians(studentId: string) {
  await loadStudent(prisma, studentId);
  return prisma.studentGuardian.findMany({ where: { studentId }, ...studentGuardiansInclude });
}

// Making one guardian primary makes the student's other guardians non-primary
async function clearOtherPrimary(tx: Prisma.TransactionClient, studentId: string, guardianId: string) {
  await tx.studentGuardian.updateMany({ where: { studentId, guardianId: { not: guardianId }, isPrimaryContact: true }, data: { isPrimaryContact: false } });
}

/** Links an existing guardian, or adds a new one, to a student */
export async function linkGuardian(studentId: string, input: LinkGuardianInput) {
  if (!input.guardianId && !input.guardian) throw Errors.GUARDIAN_INPUT_REQUIRED();
  if (input.guardianId && input.guardian) throw Errors.GUARDIAN_INPUT_AMBIGUOUS();

  return prisma.$transaction(async (tx) => {
    // Lock the student so two requests can't both add a 'first' (primary) guardian
    await tx.$queryRaw`SELECT id FROM student_profiles WHERE id = ${studentId} FOR UPDATE`;
    const student = await loadStudent(tx, studentId);
    const existing = await tx.studentGuardian.findMany({ where: { studentId } });
    if (existing.length >= MAX_GUARDIANS_PER_STUDENT) throw Errors.TOO_MANY_GUARDIANS(MAX_GUARDIANS_PER_STUDENT);

    let guardian;
    if (input.guardianId) {
      guardian = await loadGuardian(tx, input.guardianId);
      if (existing.some((l) => l.guardianId === guardian!.id)) throw Errors.GUARDIAN_ALREADY_LINKED(guardian.latinName, student.studentIdentifier);
    } else {
      guardian = await tx.guardian.create({ data: input.guardian!, include: withStudents });
      await audit(tx, { ...auditGuardian(guardian), action: 'GUARDIAN_CREATED', after: scalars(guardian) });
    }

    const isPrimaryContact = existing.length === 0 || input.isPrimaryContact === true;
    if (isPrimaryContact) await clearOtherPrimary(tx, studentId, guardian.id);
    const link = await tx.studentGuardian.create({
      data: { studentId, guardianId: guardian.id, relationship: input.relationship, isPrimaryContact },
      include: { guardian: true },
    });
    await audit(tx, { ...auditStudent(student), action: 'GUARDIAN_LINKED', after: linkSnapshot(link, guardian) });
    return link;
  });
}

/** Changes how a guardian is related to the student, or makes them the primary contact */
export async function updateGuardianLink(
  studentId: string,
  guardianId: string,
  data: { relationship?: GuardianRelationship; isPrimaryContact?: boolean },
) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM student_profiles WHERE id = ${studentId} FOR UPDATE`;
    const student = await loadStudent(tx, studentId);
    const current = await tx.studentGuardian.findUnique({ where: { studentId_guardianId: { studentId, guardianId } }, include: { guardian: true } });
    if (!current) throw Errors.GUARDIAN_NOT_LINKED((await loadGuardian(tx, guardianId)).latinName, student.studentIdentifier);

    if (data.isPrimaryContact) await clearOtherPrimary(tx, studentId, guardianId);
    // Removing the primary flag hands it to the student's longest-linked other guardian, so there is always one
    if (data.isPrimaryContact === false && current.isPrimaryContact) {
      const next = await tx.studentGuardian.findFirst({ where: { studentId, guardianId: { not: guardianId } }, orderBy: { createdAt: 'asc' } });
      if (!next) data = { ...data, isPrimaryContact: true }; // the only guardian stays primary
      else await tx.studentGuardian.update({ where: { studentId_guardianId: { studentId, guardianId: next.guardianId } }, data: { isPrimaryContact: true } });
    }
    const updated = await tx.studentGuardian.update({ where: { studentId_guardianId: { studentId, guardianId } }, data, include: { guardian: true } });
    await audit(tx, {
      ...auditStudent(student),
      action: 'GUARDIAN_LINK_UPDATED',
      before: linkSnapshot(current, current.guardian),
      after: linkSnapshot(updated, updated.guardian),
    });
    return updated;
  });
}

/** Unlinks a guardian from one student; the guardian record stays (they may have other children here) */
export async function unlinkGuardian(studentId: string, guardianId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM student_profiles WHERE id = ${studentId} FOR UPDATE`;
    const student = await loadStudent(tx, studentId);
    const link = await tx.studentGuardian.findUnique({ where: { studentId_guardianId: { studentId, guardianId } }, include: { guardian: true } });
    if (!link) throw Errors.GUARDIAN_NOT_LINKED((await loadGuardian(tx, guardianId)).latinName, student.studentIdentifier);

    await tx.studentGuardian.delete({ where: { studentId_guardianId: { studentId, guardianId } } });
    if (link.isPrimaryContact) {
      const next = await tx.studentGuardian.findFirst({ where: { studentId }, orderBy: { createdAt: 'asc' } });
      if (next) await tx.studentGuardian.update({ where: { studentId_guardianId: { studentId, guardianId: next.guardianId } }, data: { isPrimaryContact: true } });
    }
    await audit(tx, { ...auditStudent(student), action: 'GUARDIAN_UNLINKED', before: linkSnapshot(link, link.guardian) });
  });
}
