import { beforeAll, describe, expect, it } from 'vitest';
import { api, assignTeacher, bearer, makeClass, makePeriod, makeStudentsIn, prisma, staffUser, subjectCode } from '../helpers';

// Two grade 7 classes. The teacher teaches MATH in class A only; KHMER in A belongs to someone else.
let principal: Awaited<ReturnType<typeof staffUser>>;
let teacher: Awaited<ReturnType<typeof staffUser>>;
let math: { id: string }, khmer: { id: string };
let classA: Awaited<ReturnType<typeof makeClass>>;
let studentA: { id: string }, studentB: { id: string };
let period: { id: string };

const score = (token: string, body: Record<string, unknown>) =>
  api.post('/api/v1/scores/subject').set(bearer(token)).send({ assessmentPeriodId: period.id, ...body });

beforeAll(async () => {
  [principal, teacher] = await Promise.all([staffUser('Principal'), staffUser('Teacher')]);
  [math, khmer] = await Promise.all([subjectCode('MATH'), subjectCode('KHMER')]);
  classA = await makeClass(7);
  const classB = await makeClass(7);
  [studentA] = await makeStudentsIn(classA, 1);
  [studentB] = await makeStudentsIn(classB, 1);
  await assignTeacher(teacher.staff.id, math.id, classA.id);
  period = await makePeriod(principal.token, [
    { subjectId: math.id, maxTotalScore: 50 },
    { subjectId: khmer.id, maxTotalScore: 50, components: [{ name: 'Homework', maxScore: 20 }, { name: 'Exam', maxScore: 30 }] },
  ]);
});

describe('teacher data scope', () => {
  it('lets the assigned teacher score their subject in their class', async () => {
    const res = await score(teacher.token, { studentId: studentA.id, subjectId: math.id, totalScoreAchieved: 42 });
    expect(res.status).toBe(201);
    expect(res.body.data.totalScore).toBe(42);
  });

  it('refuses a subject the teacher does not teach in that class', async () => {
    const res = await score(teacher.token, { studentId: studentA.id, subjectId: khmer.id, totalScoreAchieved: 40 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_TEACHING_SUBJECT');
  });

  it("refuses their subject in a class they don't teach", async () => {
    const res = await score(teacher.token, { studentId: studentB.id, subjectId: math.id, totalScoreAchieved: 40 });
    expect(res.status).toBe(403);
  });

  it('lets the principal (ENTER_ANY_SCORES) correct any score', async () => {
    const res = await score(principal.token, { studentId: studentB.id, subjectId: math.id, totalScoreAchieved: 30 });
    expect(res.status).toBe(201);
  });
});

describe("the month's rules", () => {
  it('rejects a total above the maximum', async () => {
    const res = await score(principal.token, { studentId: studentA.id, subjectId: math.id, totalScoreAchieved: 51 });
    expect(res.body.code).toBe('SCORE_OUT_OF_RANGE');
  });

  it('requires every component, each within its maximum, and stores their sum', async () => {
    const config = await prisma.subjectAssessmentConfig.findFirstOrThrow({ where: { assessmentPeriodId: period.id, subjectId: khmer.id }, include: { components: true } });
    const id = (name: string) => config.components.find((c) => c.name === name)!.id;

    const missing = await score(principal.token, { studentId: studentA.id, subjectId: khmer.id, components: [{ componentId: id('Exam'), score: 20 }] });
    expect(missing.body.code).toBe('COMPONENTS_MISMATCH');
    expect(missing.body.details.missing.map((m: { name: string }) => m.name)).toEqual(['Homework']);

    const tooHigh = await score(principal.token, { studentId: studentA.id, subjectId: khmer.id, components: [{ componentId: id('Exam'), score: 31 }, { componentId: id('Homework'), score: 10 }] });
    expect(tooHigh.body.code).toBe('SCORE_OUT_OF_RANGE');

    const ok = await score(principal.token, { studentId: studentA.id, subjectId: khmer.id, components: [{ componentId: id('Exam'), score: 27.5 }, { componentId: id('Homework'), score: 18.25 }] });
    expect(ok.status).toBe(201);
    expect(ok.body.data.totalScore).toBe(45.75);
  });

  it('freezes a subject\'s rules once a score exists under them', async () => {
    const res = await api.put(`/api/v1/assessment-periods/${period.id}/subjects/${math.id}`).set(bearer(principal.token)).send({ maxTotalScore: 40 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RULES_HAVE_SCORES');
  });
});

describe('deadline and lock', () => {
  it('stops teachers after the score entry deadline, but not the principal', async () => {
    await prisma.assessmentPeriod.update({ where: { id: period.id }, data: { scoreEntryDeadline: new Date('2026-01-01') } });
    const byTeacher = await score(teacher.token, { studentId: studentA.id, subjectId: math.id, totalScoreAchieved: 43 });
    expect(byTeacher.body.code).toBe('SCORE_DEADLINE_PASSED');
    const byPrincipal = await score(principal.token, { studentId: studentA.id, subjectId: math.id, totalScoreAchieved: 43 });
    expect(byPrincipal.status).toBe(200);
    await prisma.assessmentPeriod.update({ where: { id: period.id }, data: { scoreEntryDeadline: null } });
  });

  it('makes a locked period read-only for everyone until it is unlocked', async () => {
    expect((await api.post(`/api/v1/assessment-periods/${period.id}/lock`).set(bearer(teacher.token))).status).toBe(403);
    expect((await api.post(`/api/v1/assessment-periods/${period.id}/lock`).set(bearer(principal.token))).status).toBe(200);

    const locked = await score(principal.token, { studentId: studentA.id, subjectId: math.id, totalScoreAchieved: 44 });
    expect(locked.body.code).toBe('PERIOD_LOCKED');

    expect((await api.post(`/api/v1/assessment-periods/${period.id}/unlock`).set(bearer(principal.token))).status).toBe(200);
    expect((await score(teacher.token, { studentId: studentA.id, subjectId: math.id, totalScoreAchieved: 44 })).status).toBe(200);
  });
});

describe('reading a score sheet', () => {
  const sheet = (token: string, subjectId: string, classSectionId = classA.id) =>
    api.get('/api/v1/scores/subject-sheet').set(bearer(token)).query({ classSectionId, subjectId, assessmentPeriodId: period.id });

  it('shows the assigned teacher the scores already entered in their subject and class', async () => {
    await score(teacher.token, { studentId: studentA.id, subjectId: math.id, totalScoreAchieved: 38 });
    const res = await sheet(teacher.token, math.id);
    expect(res.status).toBe(200);
    expect(res.body.data.rules).toMatchObject({ maxTotalScore: 50, isComponentBased: false });
    expect(res.body.data.canEdit).toBe(true);
    expect(res.body.data.lockReason).toBeNull();
    const row = res.body.data.students.find((s: { id: string }) => s.id === studentA.id);
    expect(row.totalScore).toBe(38);
    expect(row.components).toBeNull();
    expect(res.body.data.summary).toMatchObject({ students: 1, entered: 1, missing: 0 });
  });

  it('gives component scores by component id in component-based months', async () => {
    const config = await prisma.subjectAssessmentConfig.findFirstOrThrow({ where: { assessmentPeriodId: period.id, subjectId: khmer.id }, include: { components: true } });
    const id = (name: string) => config.components.find((c) => c.name === name)!.id;
    await score(principal.token, { studentId: studentA.id, subjectId: khmer.id, components: [{ componentId: id('Exam'), score: 25 }, { componentId: id('Homework'), score: 15 }] });

    const res = await sheet(principal.token, khmer.id);
    expect(res.status).toBe(200);
    expect(res.body.data.rules.components.map((c: { name: string }) => c.name)).toEqual(['Exam', 'Homework']);
    const row = res.body.data.students.find((s: { id: string }) => s.id === studentA.id);
    expect(row.totalScore).toBe(40);
    expect(row.components).toEqual({ [id('Exam')]: 25, [id('Homework')]: 15 });
  });

  it("refuses a subject the teacher doesn't teach in that class, before revealing any score", async () => {
    const res = await sheet(teacher.token, khmer.id);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_TEACHING_SUBJECT');
    expect(res.body.data).toBeUndefined();
  });

  it('reports a locked period as not editable', async () => {
    const locked = await makePeriod(principal.token, [{ subjectId: math.id, maxTotalScore: 50 }]);
    await api.post(`/api/v1/assessment-periods/${locked.id}/lock`).set(bearer(principal.token)).expect(200);
    const res = await api
      .get('/api/v1/scores/subject-sheet')
      .set(bearer(teacher.token))
      .query({ classSectionId: classA.id, subjectId: math.id, assessmentPeriodId: locked.id });
    expect(res.status).toBe(200);
    expect(res.body.data.canEdit).toBe(false);
    expect(res.body.data.lockReason).toBe('PERIOD_LOCKED');
  });
});
