import { beforeAll, describe, expect, it } from 'vitest';
import { api, bearer, makeClass, makeStudent, prisma, staffUser, yearNamed } from '../helpers';

let registrar: Awaited<ReturnType<typeof staffUser>>;
let teacher: Awaited<ReturnType<typeof staffUser>>;
let year: { id: string };
let nextYear: { id: string };

const enroll = (studentId: string, classSection: { id: string }, academicYearId = year.id, token = registrar.token) =>
  api.post('/api/v1/enrollments').set(bearer(token)).send({ studentId, classSectionId: classSection.id, academicYearId });

beforeAll(async () => {
  [registrar, teacher] = await Promise.all([staffUser('Registrar'), staffUser('Teacher')]);
  [year, nextYear] = await Promise.all([yearNamed('2026-2027'), yearNamed('2027-2028')]);
});

describe('enrolling', () => {
  it('enrolls a new student as a new admission', async () => {
    const [student, classSection] = await Promise.all([makeStudent(), makeClass(7)]);
    const res = await enroll(student.id, classSection);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ enrollmentType: 'NEW_ADMISSION' });
  });

  it('allows one class per student per year', async () => {
    const [student, first, second] = await Promise.all([makeStudent(), makeClass(7), makeClass(7)]);
    expect((await enroll(student.id, first)).status).toBe(201);
    const res = await enroll(student.id, second);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_ENROLLED');
  });

  it('stops at the class’s capacity', async () => {
    const classSection = await makeClass(7, { capacity: 1 });
    const [a, b] = await Promise.all([makeStudent(), makeStudent()]);
    expect((await enroll(a.id, classSection)).status).toBe(201);
    const res = await enroll(b.id, classSection);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CLASS_CAPACITY_REACHED');
    expect(res.body.details).toEqual({ maxCapacity: 1, currentEnrollment: 1 });
  });

  it('refuses a class from another year, or a student who has left', async () => {
    const student = await makeStudent();
    const res = await enroll(student.id, await makeClass(7), nextYear.id);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ACADEMIC_YEAR_MISMATCH');

    await prisma.studentProfile.update({ where: { id: student.id }, data: { status: 'DROPPED_OUT' } });
    const left = await enroll(student.id, await makeClass(7));
    expect(left.status).toBe(409);
    expect(left.body.code).toBe('STUDENT_NOT_ACTIVE');
  });

  it('is not for teachers', async () => {
    const student = await makeStudent();
    expect((await enroll(student.id, await makeClass(7), year.id, teacher.token)).status).toBe(403);
  });
});

describe('transfers and corrections', () => {
  it('moves a student to another class of the same year', async () => {
    const [student, from, to] = await Promise.all([makeStudent(), makeClass(8), makeClass(8)]);
    const enrollment = (await enroll(student.id, from)).body.data;

    const res = await api.patch(`/api/v1/enrollments/${enrollment.id}`).set(bearer(registrar.token)).send({ classSectionId: to.id });
    expect(res.status).toBe(200);
    const roster = await api.get(`/api/v1/class-sections/${to.id}/roster`).set(bearer(registrar.token));
    expect(roster.body.data.students.map((s: { id: string }) => s.id)).toContain(student.id);

    const same = await api.patch(`/api/v1/enrollments/${enrollment.id}`).set(bearer(registrar.token)).send({ classSectionId: to.id });
    expect(same.status).toBe(400);
    expect(same.body.code).toBe('SAME_CLASS_SECTION');
  });

  it('refuses a transfer into another year', async () => {
    const [student, from, later] = await Promise.all([makeStudent(), makeClass(8), makeClass(9, { year: '2027-2028' })]);
    const enrollment = (await enroll(student.id, from)).body.data;
    const res = await api.patch(`/api/v1/enrollments/${enrollment.id}`).set(bearer(registrar.token)).send({ classSectionId: later.id });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ACADEMIC_YEAR_MISMATCH');
  });

  it('deletes an enrollment made by mistake, so the student can be enrolled again', async () => {
    const [student, wrong, right] = await Promise.all([makeStudent(), makeClass(9), makeClass(9)]);
    const enrollment = (await enroll(student.id, wrong)).body.data;
    expect((await api.delete(`/api/v1/enrollments/${enrollment.id}`).set(bearer(registrar.token))).status).toBe(204);
    expect((await enroll(student.id, right)).status).toBe(201);
  });

  it('lists a class’s enrollments', async () => {
    const [classSection, a, b] = await Promise.all([makeClass(9), makeStudent(), makeStudent()]);
    await enroll(a.id, classSection);
    await enroll(b.id, classSection);
    const res = await api.get('/api/v1/enrollments').query({ classSectionId: classSection.id }).set(bearer(teacher.token));
    expect(res.status).toBe(200);
    expect(res.body.data.map((e: { student: { id: string } }) => e.student.id).sort()).toEqual([a.id, b.id].sort());
  });
});
