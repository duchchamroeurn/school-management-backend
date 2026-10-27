// Makes half-day classes full-day classes (shift MORNING / AFTERNOON → none), for schools whose classes study
// Monday–Friday all day and Saturday morning. Only classes of academic years that aren't completed are changed:
// a completed year's classes stay as they were.
//
//   npm run db:classes:full-day -- --dry-run     # show what would change
//   npm run db:classes:full-day                  # change it
//
// A full-day class has its home room to itself. Where two half-day classes of a year shared a room, the morning
// class keeps it and the others lose it; they are listed so someone can give them a room. Every change is audited.
import { AcademicYearStatus } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { audit } from '../services/audit.service';

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const classes = await prisma.classSection.findMany({
    where: { shift: { not: null }, academicYear: { status: { not: AcademicYearStatus.COMPLETED } } },
    include: { grade: true, academicYear: true, room: true },
    // Morning before afternoon, so a shared room stays with the morning class
    orderBy: [{ academicYearId: 'asc' }, { shift: 'asc' }, { grade: { gradeNumber: 'asc' } }, { sectionName: 'asc' }],
  });
  if (!classes.length) {
    console.log('No half-day classes in open academic years: nothing to change.');
    return;
  }

  // Full-day classes already holding a room keep it too
  const taken = new Set(
    (
      await prisma.classSection.findMany({
        where: { shift: null, roomId: { not: null }, academicYear: { status: { not: AcademicYearStatus.COMPLETED } } },
        select: { roomId: true, academicYearId: true },
      })
    ).map((c) => `${c.academicYearId}:${c.roomId}`),
  );

  const plan = classes.map((c) => {
    const key = `${c.academicYearId}:${c.roomId}`;
    const keepsRoom = !c.roomId || !taken.has(key);
    if (c.roomId && keepsRoom) taken.add(key);
    return { classSection: c, name: `${c.grade.gradeNumber}${c.sectionName} ${c.academicYear.name}`, keepsRoom };
  });

  for (const { classSection: c, name, keepsRoom } of plan) {
    const room = c.room ? (keepsRoom ? ` (keeps ${c.room.name})` : ` — loses ${c.room.name}, shared with another class: give it a room`) : '';
    console.log(`  ${dryRun ? '~' : '✓'} ${name}: ${c.shift!.toLowerCase()} → full day${room}`);
  }

  if (dryRun) {
    console.log(`\nDry run: ${plan.length} class(es) would become full day. Nothing was changed.`);
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const { classSection: c, name, keepsRoom } of plan) {
      await tx.classSection.update({ where: { id: c.id }, data: { shift: null, ...(!keepsRoom && { roomId: null }) } });
      await audit(tx, {
        entityType: 'ClassSection',
        action: 'CLASS_SECTION_UPDATED',
        entityId: c.id,
        entityLabel: name,
        before: { shift: c.shift, roomId: c.roomId },
        after: { shift: null, roomId: keepsRoom ? c.roomId : null },
      });
    }
  });
  const lost = plan.filter((p) => !p.keepsRoom).length;
  console.log(`\n${plan.length} class(es) are now full day${lost ? `; ${lost} need a home room (see above)` : ''}.`);
}

main()
  .catch((err) => {
    console.error(`✘ ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
