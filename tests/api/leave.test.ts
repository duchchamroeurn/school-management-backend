import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { api, bearer, makeClass, makeStudentsIn, prisma, staffUser } from '../helpers';

// Attendance in the active year needs "today" to be inside it (see attendance.test.ts). Only February dates
// are used: other test files put calendar entries in March 2027.
const TODAY = '2027-02-26';

let principal: Awaited<ReturnType<typeof staffUser>>;
let teacher: Awaited<ReturnType<typeof staffUser>>; // homeroom teacher; may record leave, not review it
let classId: string;
let students: Awaited<ReturnType<typeof makeStudentsIn>>;

const request = (studentId: string, startDate: string, endDate: string, token = teacher.token) =>
  api.post('/api/v1/leave-requests').set(bearer(token)).send({ studentId, startDate, endDate, reason: 'Family event' });
const act = (id: string, action: 'approve' | 'reject' | 'cancel', token = principal.token) =>
  api.post(`/api/v1/leave-requests/${id}/${action}`).set(bearer(token));
const markAbsent = (studentId: string, date: string) =>
  api.post('/api/v1/attendance').set(bearer(teacher.token)).send({ classSectionId: classId, date, records: [{ studentId, status: 'ABSENT_UNEXCUSED' }] });
const statusOn = async (studentId: string, date: string) =>
  (await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId, date: new Date(date), subjectId: null } })).status;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T03:00:00.000Z`));

  [principal, teacher] = await Promise.all([staffUser('Principal'), staffUser('Teacher')]);
  const classSection = await makeClass(8, { homeroomTeacherId: teacher.staff.id });
  classId = classSection.id;
  students = await makeStudentsIn(classSection, 4);
});

afterAll(() => {
  vi.useRealTimers();
});

describe('recording leave', () => {
  it('records a request as pending, with its days', async () => {
    const res = await request(students[0]!.id, '2027-02-01', '2027-02-03');
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'PENDING', days: 3, schoolDays: 3, reason: 'Family event' });
  });

  it('refuses a request overlapping a pending or approved one', async () => {
    const res = await request(students[0]!.id, '2027-02-03', '2027-02-05');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LEAVE_OVERLAP');
  });

  it('refuses dates the wrong way round, or more than 90 days', async () => {
    const backwards = await request(students[1]!.id, '2027-02-10', '2027-02-09');
    expect(backwards.status).toBe(400);
    expect(backwards.body.details.field).toBe('endDate');

    const tooLong = await request(students[1]!.id, '2027-01-01', '2027-04-30');
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.details.field).toBe('endDate');
  });

  it('refuses leave for a student who has left', async () => {
    const [leaver] = await makeStudentsIn(await makeClass(8), 1);
    await prisma.studentProfile.update({ where: { id: leaver!.id }, data: { status: 'DROPPED_OUT' } });
    const res = await request(leaver!.id, '2027-02-01', '2027-02-01');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STUDENT_NOT_ACTIVE');
  });

  it('lists requests by student and status', async () => {
    const res = await api.get('/api/v1/leave-requests').query({ studentId: students[0]!.id, status: 'PENDING' }).set(bearer(teacher.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta.total).toBe(1);
  });
});

describe('reviewing leave', () => {
  it('is for reviewers only: a teacher can record but not approve', async () => {
    const leave = (await request(students[1]!.id, '2027-02-08', '2027-02-08')).body.data;
    const res = await act(leave.id, 'approve', teacher.token);
    expect(res.status).toBe(403);
  });

  it('approving excuses absences already recorded in the range', async () => {
    const student = students[2]!;
    expect((await markAbsent(student.id, '2027-02-15')).status).toBe(200);
    expect((await markAbsent(student.id, '2027-02-16')).status).toBe(200);
    expect((await markAbsent(student.id, '2027-02-17')).status).toBe(200); // outside the leave

    const leave = (await request(student.id, '2027-02-15', '2027-02-16')).body.data;
    const res = await act(leave.id, 'approve');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ leaveRequest: { status: 'APPROVED' }, excusedAbsences: 2 });
    expect(await statusOn(student.id, '2027-02-15')).toBe('ABSENT_EXCUSED');
    expect(await statusOn(student.id, '2027-02-17')).toBe('ABSENT_UNEXCUSED');
  });

  it('cancelling an approved leave makes its absences unexcused again', async () => {
    const student = students[2]!;
    const leave = await prisma.leaveRequest.findFirstOrThrow({ where: { studentId: student.id, status: 'APPROVED' } });
    const res = await act(leave.id, 'cancel');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ leaveRequest: { status: 'CANCELLED' }, revertedAbsences: 2 });
    expect(await statusOn(student.id, '2027-02-15')).toBe('ABSENT_UNEXCUSED');
  });

  it('only a pending request can be approved or rejected', async () => {
    const leave = (await request(students[3]!.id, '2027-02-19', '2027-02-19')).body.data;
    expect((await act(leave.id, 'reject')).body.data.leaveRequest.status).toBe('REJECTED');

    const again = await act(leave.id, 'approve');
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('LEAVE_STATUS_INVALID');

    // A rejected request no longer blocks a new one for the same days
    expect((await request(students[3]!.id, '2027-02-19', '2027-02-19')).status).toBe(201);
  });

  it('records each decision in the audit log', async () => {
    const leave = await prisma.leaveRequest.findFirstOrThrow({ where: { studentId: students[2]!.id, status: 'CANCELLED' } });
    const actions = (await prisma.auditLog.findMany({ where: { entityId: leave.id }, orderBy: { createdAt: 'asc' } })).map((a) => a.action);
    expect(actions).toEqual(['LEAVE_REQUEST_CREATED', 'LEAVE_REQUEST_APPROVED', 'LEAVE_REQUEST_CANCELLED']);
  });
});
