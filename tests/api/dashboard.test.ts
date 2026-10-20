import { beforeAll, describe, expect, it } from 'vitest';
import { api, assignTeacher, bearer, makeClass, makeLogin, makePeriod, makeStudentsIn, prisma, staffUser, subjectCode, tokenFor } from '../helpers';

let principal: Awaited<ReturnType<typeof staffUser>>;
let registrar: Awaited<ReturnType<typeof staffUser>>;
let admin: Awaited<ReturnType<typeof staffUser>>;
let teacher: Awaited<ReturnType<typeof staffUser>>;
let classSection: Awaited<ReturnType<typeof makeClass>>;
let students: Awaited<ReturnType<typeof makeStudentsIn>>;
let period: { id: string };
let studentToken: string;

const dashboard = async (token: string) => {
  const res = await api.get('/api/v1/dashboard').set(bearer(token));
  expect(res.status).toBe(200);
  return res.body.data;
};

beforeAll(async () => {
  [principal, registrar, admin, teacher] = await Promise.all([staffUser('Principal'), staffUser('Registrar'), staffUser('System Admin'), staffUser('Teacher')]);
  const [math, khmer] = await Promise.all([subjectCode('MATH'), subjectCode('KHMER')]);
  // The teacher is homeroom teacher of this class and teaches MATH in it; 3 students
  classSection = await makeClass(9, { homeroomTeacherId: teacher.staff.id });
  students = await makeStudentsIn(classSection, 3);
  await assignTeacher(teacher.staff.id, math.id, classSection.id);
  period = await makePeriod(principal.token, [{ subjectId: math.id, maxTotalScore: 50 }, { subjectId: khmer.id, maxTotalScore: 50 }]);
  // One of the three MATH scores is in
  await api.post('/api/v1/scores/subject').set(bearer(teacher.token)).send({ studentId: students[0].id, subjectId: math.id, assessmentPeriodId: period.id, totalScoreAchieved: 40 });

  const { username } = await makeLogin('Student', { studentId: students[1].id });
  studentToken = await tokenFor(username);
});

describe('dashboard sections follow permissions', () => {
  it('gives the principal the school-wide sections', async () => {
    const { sections, academicYear } = await dashboard(principal.token);
    expect(academicYear.name).toBe('2026-2027');
    expect(Object.keys(sections)).toEqual(expect.arrayContaining(['enrollment', 'capacity', 'attendanceToday', 'scoreEntry', 'staffing', 'dataQuality', 'pendingLeave', 'security']));
    expect(sections).not.toHaveProperty('myStudent');
  });

  it('gives the registrar intake sections but not staffing, scores or security', async () => {
    const keys = Object.keys((await dashboard(registrar.token)).sections);
    expect(keys).toEqual(expect.arrayContaining(['enrollment', 'capacity', 'attendanceToday', 'dataQuality']));
    for (const hidden of ['scoreEntry', 'staffing', 'security', 'pendingLeave']) expect(keys).not.toContain(hidden);
  });

  it('gives a teacher only their own homeroom and score entry', async () => {
    const { sections } = await dashboard(teacher.token);
    expect(Object.keys(sections).sort()).toEqual(['myHomeroom', 'myScoreEntry']);
  });

  it('gives a student only their own summary', async () => {
    const { sections } = await dashboard(studentToken);
    expect(Object.keys(sections)).toEqual(['myStudent']);
    expect(sections.myStudent.classSection.id).toBe(classSection.id);
    expect(sections.myStudent.latestResult).toBeNull();
  });
});

describe('dashboard figures', () => {
  it("shows the teacher's own remaining scores and homeroom status", async () => {
    const { myScoreEntry, myHomeroom } = (await dashboard(teacher.token)).sections;
    expect(myScoreEntry.items).toEqual([expect.objectContaining({ assessmentPeriodId: period.id, classSectionId: classSection.id, subject: 'MATH', entered: 1, students: 3, remaining: 2 })]);
    expect(myHomeroom).toMatchObject({ classSectionId: classSection.id, students: { total: 3, female: 3 }, pendingLeaveRequests: 0 });
    expect(myHomeroom.results.find((r: { assessmentPeriodId: string }) => r.assessmentPeriodId === period.id)).toMatchObject({ calculated: false });
  });

  it('shows school score progress, capacity and staffing gaps', async () => {
    const { scoreEntry, capacity, staffing } = (await dashboard(principal.token)).sections;
    const mine = scoreEntry.find((p: { assessmentPeriodId: string }) => p.assessmentPeriodId === period.id);
    expect(mine).toMatchObject({ subjectsScored: 2, scoresEntered: 1 });
    expect(mine.scoresExpected).toBeGreaterThanOrEqual(6); // at least this class: 3 students × 2 subjects

    expect(capacity.byClass.find((c: { classSectionId: string }) => c.classSectionId === classSection.id)).toMatchObject({ enrolled: 3, maxCapacity: 40, seatsLeft: 37 });
    const gaps = staffing.vacancies.find((v: { classSectionId: string }) => v.classSectionId === classSection.id);
    expect(gaps.vacantSubjects).toContain('KHMER');
    expect(gaps.vacantSubjects).not.toContain('MATH');
  });

  it('flags logins from outside the school network for the admin', async () => {
    await prisma.auditLog.create({ data: { action: 'LOGIN_SUCCEEDED', entityType: 'User', actorUsername: 'someone', ipAddress: '203.0.113.7' } });
    const { security } = (await dashboard(admin.token)).sections;
    expect(security.last24h.externalLogins).toEqual(expect.arrayContaining([expect.objectContaining({ username: 'someone', ipAddress: '203.0.113.7' })]));
    expect(security.last24h.externalLogins.every((l: { ipAddress: string }) => !l.ipAddress.includes('127.0.0.1'))).toBe(true);
    expect(security.users.active).toBeGreaterThan(0);
  });
});
