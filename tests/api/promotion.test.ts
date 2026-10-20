import { beforeAll, describe, expect, it } from 'vitest';
import { api, bearer, makeClass, makeStudentsIn, prisma, staffUser } from '../helpers';

let registrar: Awaited<ReturnType<typeof staffUser>>;
beforeAll(async () => {
  registrar = await staffUser('Registrar');
});

const promote = (classSectionId: string, body: Record<string, unknown>) =>
  api.post(`/api/v1/class-sections/${classSectionId}/promote`).set(bearer(registrar.token)).send(body);
const enrolledIn = (classSectionId: string) => prisma.yearlyEnrollment.count({ where: { classSectionId } });

describe('end-of-year promotion', () => {
  it('moves nothing when one student cannot be placed (all-or-nothing)', async () => {
    const source = await makeClass(7);
    await makeStudentsIn(source, 3);
    const target = await makeClass(8, { year: '2027-2028', capacity: 2 });

    const res = await promote(source.id, { promotedClassSectionId: target.id });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CLASS_CAPACITY_REACHED');
    expect(await enrolledIn(target.id)).toBe(0);
  });

  it('writes nothing on a dry run, then promotes, repeats and skips as asked', async () => {
    const source = await makeClass(7);
    const [repeater, leaving, ...others] = await makeStudentsIn(source, 4);
    const promoted = await makeClass(8, { year: '2027-2028' });
    const repeating = await makeClass(7, { year: '2027-2028' });
    const body = { promotedClassSectionId: promoted.id, repeatingClassSectionId: repeating.id, repeatingStudentIds: [repeater.id], excludedStudentIds: [leaving.id] };

    const dry = await promote(source.id, { ...body, dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body.data.summary).toEqual({ promoted: 2, repeating: 1, graduated: 0, skipped: 1 });
    expect(await enrolledIn(promoted.id)).toBe(0);

    const real = await promote(source.id, body);
    expect(real.status).toBe(201);
    expect(await enrolledIn(promoted.id)).toBe(2);
    const repeat = await prisma.yearlyEnrollment.findFirstOrThrow({ where: { classSectionId: repeating.id } });
    expect(repeat).toMatchObject({ studentId: repeater.id, enrollmentType: 'REPEATING' });
    expect(others).toHaveLength(2);

    const again = await promote(source.id, body);
    expect(again.body.data.summary).toMatchObject({ promoted: 0, repeating: 0 });
    expect(again.body.data.skipped.alreadyEnrolled).toHaveLength(3);
  });

  it('graduates students of the top grade instead of promoting them', async () => {
    const source = await makeClass(12);
    const students = await makeStudentsIn(source, 2);
    expect((await promote(source.id, { promotedClassSectionId: source.id })).body.code).toBe('VALIDATION_ERROR');

    const res = await promote(source.id, {});
    expect(res.body.data.summary).toMatchObject({ graduated: 2, promoted: 0 });
    const statuses = await prisma.studentProfile.findMany({ where: { id: { in: students.map((s) => s.id) } }, select: { status: true } });
    expect(statuses.map((s) => s.status)).toEqual(['GRADUATED', 'GRADUATED']);
  });

  it('checks the target grade and year', async () => {
    const source = await makeClass(7);
    await makeStudentsIn(source, 1);
    const sameGrade = await makeClass(7, { year: '2027-2028' });
    const sameYear = await makeClass(8);
    expect((await promote(source.id, { promotedClassSectionId: sameGrade.id })).body.message).toMatch(/grade 8/);
    expect((await promote(source.id, { promotedClassSectionId: sameYear.id })).body.message).toMatch(/year after/);
  });
});
