import { beforeAll, describe, expect, it } from 'vitest';
import { api, bearer, makeClass, makePeriod, makeStudentsIn, staffUser, subjectCode } from '../helpers';

// Four students, MATH and KHMER each /50 (maximum 100). Two tie at the top.
const SCORES = [
  { math: 45, khmer: 45, average: 90, mention: 'A', rank: 1 },
  { math: 50, khmer: 40, average: 90, mention: 'A', rank: 1 },
  { math: 40, khmer: 30, average: 70, mention: 'C', rank: 3 },
  { math: 20, khmer: 29.5, average: 49.5, mention: 'F', rank: 4 },
];

let principal: Awaited<ReturnType<typeof staffUser>>;
let homeroom: Awaited<ReturnType<typeof staffUser>>;
let otherTeacher: Awaited<ReturnType<typeof staffUser>>;
let classSection: Awaited<ReturnType<typeof makeClass>>;
let students: Awaited<ReturnType<typeof makeStudentsIn>>;
let period: { id: string };
let math: { id: string }, khmer: { id: string };

const calculate = (token: string) =>
  api.post('/api/v1/scores/results/calculate').set(bearer(token)).send({ classSectionId: classSection.id, assessmentPeriodId: period.id });
const enter = (studentId: string, subjectId: string, totalScoreAchieved: number) =>
  api.post('/api/v1/scores/subject').set(bearer(principal.token)).send({ studentId, subjectId, assessmentPeriodId: period.id, totalScoreAchieved });

beforeAll(async () => {
  [principal, homeroom, otherTeacher] = await Promise.all([staffUser('Principal'), staffUser('Teacher'), staffUser('Teacher')]);
  [math, khmer] = await Promise.all([subjectCode('MATH'), subjectCode('KHMER')]);
  classSection = await makeClass(8, { homeroomTeacherId: homeroom.staff.id });
  students = await makeStudentsIn(classSection, SCORES.length);
  period = await makePeriod(principal.token, [
    { subjectId: math.id, maxTotalScore: 50 },
    { subjectId: khmer.id, maxTotalScore: 50 },
  ]);
  // Everything except the last student's KHMER score
  for (const [i, s] of SCORES.entries()) {
    await enter(students[i].id, math.id, s.math);
    if (i < SCORES.length - 1) await enter(students[i].id, khmer.id, s.khmer);
  }
});

describe('calculating period results', () => {
  it('refuses while a score is missing, naming the student and subject', async () => {
    const res = await calculate(homeroom.token);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SCORES_INCOMPLETE');
    expect(res.body.details.missing).toEqual([expect.objectContaining({ studentIdentifier: students[3].studentIdentifier, subjects: ['KHMER'] })]);
  });

  it('only lets the homeroom teacher (or CALCULATE_ANY_RESULTS) calculate', async () => {
    expect((await calculate(otherTeacher.token)).body.code).toBe('NOT_HOMEROOM_FOR_CLASS');
  });

  it('ranks by average with shared ranks for ties, and applies the A–F scale', async () => {
    await enter(students[3].id, khmer.id, SCORES[3].khmer);
    const res = await calculate(homeroom.token);
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toMatchObject({ students: 4, maxTotal: 100, passed: 3 });

    const byStudent = new Map(res.body.data.results.map((r: { studentId: string }) => [r.studentId, r]));
    for (const [i, expected] of SCORES.entries()) {
      expect(byStudent.get(students[i].id)).toMatchObject({ average: expected.average, mention: expected.mention, classRank: expected.rank });
    }
  });

  it('keeps the teacher\'s remarks when results are recalculated', async () => {
    const remarks = 'ខិតខំរៀនល្អ';
    const set = await api.patch('/api/v1/scores/results/remarks').set(bearer(homeroom.token)).send({ assessmentPeriodId: period.id, studentId: students[0].id, remarks });
    expect(set.status).toBe(200);
    await calculate(homeroom.token);

    const cards = await api.get(`/api/v1/reports/report-cards/${classSection.id}?assessmentPeriodId=${period.id}&studentId=${students[0].id}`).set(bearer(homeroom.token));
    expect(cards.body.data.cards[0].remarks).toBe(remarks);
  });
});
