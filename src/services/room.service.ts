// Classrooms. Each class has a home room; because rooms are scarce, a morning class and an afternoon class
// share one (enforced on the class: one class per room per shift each year).
import { Errors } from '../constants/errors';
import { AcademicYearStatus, Prisma } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { audit, scalars } from './audit.service';

export interface RoomInput {
  name: string;
  capacity?: number | null;
}

// Who uses the room this year, by shift
const withActiveClasses = {
  classes: {
    where: { academicYear: { status: AcademicYearStatus.ACTIVE } },
    select: { id: true, sectionName: true, schedule: true, grade: { select: { gradeNumber: true } } },
    orderBy: { schedule: 'asc' },
  },
} satisfies Prisma.RoomInclude;

const auditRoom = (r: { id: string; name: string }) => ({ entityType: 'Room', entityId: r.id, entityLabel: r.name }) as const;
const nameTaken = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

export const listRooms = () => prisma.room.findMany({ include: withActiveClasses, orderBy: { name: 'asc' } });

export async function createRoom(data: RoomInput) {
  try {
    return await prisma.$transaction(async (tx) => {
      const created = await tx.room.create({ data, include: withActiveClasses });
      await audit(tx, { ...auditRoom(created), action: 'ROOM_CREATED', after: scalars(created) });
      return created;
    });
  } catch (err) {
    if (nameTaken(err)) throw Errors.ROOM_EXISTS(data.name);
    throw err;
  }
}

export async function updateRoom(id: string, data: Partial<RoomInput>) {
  try {
    return await prisma.$transaction(async (tx) => {
      const current = await tx.room.findUnique({ where: { id } });
      if (!current) throw Errors.ROOM_NOT_FOUND();
      const updated = await tx.room.update({ where: { id }, data, include: withActiveClasses });
      await audit(tx, { ...auditRoom(updated), action: 'ROOM_UPDATED', before: scalars(current), after: scalars(updated) });
      return updated;
    });
  } catch (err) {
    if (nameTaken(err)) throw Errors.ROOM_EXISTS(data.name ?? '');
    throw err;
  }
}

/** Only a room no class (in any year) uses */
export async function deleteRoom(id: string) {
  await prisma.$transaction(async (tx) => {
    const room = await tx.room.findUnique({ where: { id }, include: { _count: { select: { classes: true } } } });
    if (!room) throw Errors.ROOM_NOT_FOUND();
    if (room._count.classes) throw Errors.ROOM_IN_USE(room.name, room._count.classes);
    await tx.room.delete({ where: { id } });
    await audit(tx, { ...auditRoom(room), action: 'ROOM_DELETED', before: scalars(room) });
  });
}
