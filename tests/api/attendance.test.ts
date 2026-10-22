import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { api, assignTeacher, bearer, makeClass, makeStudentsIn, prisma, staffUser, subjectCode } from '../helpers';

// The active year (2026-2027) starts on 1 November 2026, and attendance can't be taken for a future day, so
// "today" is set to Friday 26 February 2027. Only the date is faked: timers (database, HTTP) run as usual.
// Dates stay in February: other test files put calendar entries in March 2027.
const TODAY = '2027-02-26';

let principal: Awaited<ReturnType<typeof staffUser>>;
let homeroom: Awaited<ReturnType<typeof staffUser>>; // homeroom teacher of the class
let mathTeacher: Awaited<ReturnType<typeof staffUser>>; // teaches MATH in the class
let otherTeacher: Awaited<ReturnType<typeof staffUser>>; // teaches nothing there
let classId: string;
let students: Awaited<ReturnType<typeof makeStudentsIn>>;
let math: { id: string };

const mark = (token: string, body: object) => api.post('/api/v1/attendance').set(bearer(token)).send(body);
const sheet = (token: string, date: string, subjectId?: string) =>
  api.get(`/api/v1/attendance/class-sections/${classId}`).query({ date, ...(subjectId && { subjectId }) }).set(bearer(token));
const everyone = (status: string) => students.map((s) => ({ studentId: s.id, status }));

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T03:00:00.000Z`)); // 10:00 in Phnom Penh

  [principal, homeroom, mathTeacher, otherTeacher] = await Promise.all([
    staffUser('Principal'),
    staffUser('Teacher'),
    staffUser('Teacher'),
    staffUser('Teacher'),
  ]);
  math = await subjectCode('MATH');
  const classSection = await makeClass(7, { homeroomTeacherId: homeroom.staff.id });
  classId = classSection.id;
  await assignTeacher(mathTeacher.staff.id, math.id, classId);
  students = await makeStudentsIn(classSection, 3);
});

afterAll(() => {
  vi.useRealTimers();
});

describe('daily attendance', () => {
  it('lets the homeroom teacher take it, and shows it on the sheet', async () => {
    const res = await mark(homeroom.token, {
      classSectionId: classId,
      date: '2027-02-15',
      records: [
        { studentId: students[0]!.id, status: 'PRESENT' },
        { studentId: students[1]!.id, status: 'LATE', remarks: 'Rain' },
        { studentId: students[2]!.id, status: 'ABSENT_UNEXCUSED' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toMatchObject({ marked: 3, present: 1, late: 1, absentUnexcused: 1 });

    const view = await sheet(homeroom.token, '2027-02-15');
    expect(view.status).toBe(200);
    const byId = new Map(view.body.data.students.map((s: { id: string }) => [s.id, s]));
    expect(byId.get(students[1]!.id)).toMatchObject({ status: 'LATE', remarks: 'Rain' });
    expect(view.body.data.summary).toMatchObject({ students: 3, marked: 3, notMarked: 0 });
  });

  it('corrects the same day instead of adding records', async () => {
    const res = await mark(homeroom.token, { classSectionId: classId, date: '2027-02-15', records: everyone('PRESENT') });
    expect(res.status).toBe(200);
    const daily = await prisma.attendanceRecord.count({ where: { classSectionId: classId, date: new Date('2027-02-15'), subjectId: null } });
    expect(daily).toBe(3);
  });

  it('refuses a future day, a day outside the year, and a day without school', async () => {
    const future = await mark(homeroom.token, { classSectionId: classId, date: '2027-03-01', records: everyone('PRESENT') });
    expect(future.status).toBe(400);
    expect(future.body.code).toBe('ATTENDANCE_DATE_INVALID');

    const beforeYear = await mark(homeroom.token, { classSectionId: classId, date: '2026-10-01', records: everyone('PRESENT') });
    expect(beforeYear.status).toBe(400);
    expect(beforeYear.body.code).toBe('ATTENDANCE_DATE_INVALID');
    // The sheet says so before anyone tries
    expect((await sheet(homeroom.token, '2026-10-01')).body.data.schoolDay).toEqual({ open: false, outsideYear: true, closedBy: null });

    const sunday = await mark(homeroom.token, { classSectionId: classId, date: '2027-02-21', records: everyone('PRESENT') });
    expect(sunday.status).toBe(400);
    expect(sunday.body.code).toBe('SCHOOL_CLOSED');
  });

  it('is only for the homeroom teacher (or MARK_ANY)', async () => {
    const res = await mark(mathTeacher.token, { classSectionId: classId, date: '2027-02-16', records: everyone('PRESENT') });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_HOMEROOM_TEACHER');

    expect((await mark(principal.token, { classSectionId: classId, date: '2027-02-16', records: everyone('PRESENT') })).status).toBe(200);
  });

  it('refuses students who are not in the class, or listed twice', async () => {
    const [outsider] = await makeStudentsIn(await makeClass(7), 1);
    const notInClass = await mark(homeroom.token, {
      classSectionId: classId,
      date: '2027-02-17',
      records: [{ studentId: outsider!.id, status: 'PRESENT' }],
    });
    expect(notInClass.status).toBe(400);
    expect(notInClass.body.code).toBe('STUDENTS_NOT_IN_CLASS');

    const twice = await mark(homeroom.token, {
      classSectionId: classId,
      date: '2027-02-17',
      records: [{ studentId: students[0]!.id, status: 'PRESENT' }, { studentId: students[0]!.id, status: 'LATE' }],
    });
    expect(twice.status).toBe(400);
    expect(twice.body.details.field).toBe('records');
  });
});

describe('subject attendance', () => {
  it('lets the subject’s teacher take it, and nobody else', async () => {
    const body = { classSectionId: classId, date: '2027-02-18', subjectId: math.id, records: everyone('PRESENT') };
    const res = await mark(mathTeacher.token, body);
    expect(res.status).toBe(200);
    expect(res.body.data.subject.code).toBe('MATH');

    // The homeroom teacher doesn't teach MATH here
    const homeroomTry = await mark(homeroom.token, body);
    expect(homeroomTry.status).toBe(403);
    expect(homeroomTry.body.code).toBe('NOT_TEACHING_SUBJECT');
  });

  it('keeps daily and subject records of the same day apart', async () => {
    await mark(homeroom.token, { classSectionId: classId, date: '2027-02-18', records: everyone('LATE') });
    const daily = await sheet(principal.token, '2027-02-18');
    const lesson = await sheet(principal.token, '2027-02-18', math.id);
    expect(daily.body.data.students.every((s: { status: string }) => s.status === 'LATE')).toBe(true);
    expect(lesson.body.data.students.every((s: { status: string }) => s.status === 'PRESENT')).toBe(true);
  });
});

describe('viewing attendance', () => {
  it('shows a teacher only the classes they teach', async () => {
    const res = await sheet(otherTeacher.token, '2027-02-15');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_CLASS_TEACHER');
    expect((await sheet(mathTeacher.token, '2027-02-15')).status).toBe(200);
  });

  it('totals a student’s daily attendance over a period', async () => {
    const res = await api
      .get(`/api/v1/attendance/students/${students[2]!.id}`)
      .query({ from: '2027-02-01', to: '2027-02-28' })
      .set(bearer(principal.token));
    expect(res.status).toBe(200);
    // Daily records on the 15th, 16th and 18th; the MATH lesson on the 18th doesn't count again
    expect(res.body.data.dailyTotals.days).toBe(3);
    expect(res.body.data.records.length).toBe(4);
  });
});

describe('approved leave', () => {
  it('turns an absence into an excused one', async () => {
    const student = students[0]!;
    const leave = await api
      .post('/api/v1/leave-requests')
      .set(bearer(homeroom.token))
      .send({ studentId: student.id, startDate: '2027-02-22', endDate: '2027-02-23', reason: 'Sick' });
    expect(leave.status).toBe(201);
    expect((await api.post(`/api/v1/leave-requests/${leave.body.data.id}/approve`).set(bearer(principal.token))).status).toBe(200);

    const res = await mark(homeroom.token, {
      classSectionId: classId,
      date: '2027-02-22',
      records: [{ studentId: student.id, status: 'ABSENT_UNEXCUSED' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toMatchObject({ absentExcused: 1, absentUnexcused: 0, excusedByLeave: 1 });
  });
});
