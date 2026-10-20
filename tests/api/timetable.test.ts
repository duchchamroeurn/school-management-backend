import { beforeAll, describe, expect, it } from 'vitest';
import { api, assignTeacher, bearer, makeClass, makeLogin, makeStudentsIn, prisma, staffUser, subjectCode, tokenFor, uid } from '../helpers';

let principal: Awaited<ReturnType<typeof staffUser>>;
let sok: Awaited<ReturnType<typeof staffUser>>; // teaches MATH in 7A and 8B
let historyTeacher: Awaited<ReturnType<typeof staffUser>>;
let c7A: Awaited<ReturnType<typeof makeClass>>, c8B: Awaited<ReturnType<typeof makeClass>>;
let math: { id: string }, history: { id: string };
const slot: Record<string, string> = {}; // "MORNING-1-1" = Monday morning period 1

const place = (classSectionId: string, slotKey: string, subjectId: string, token = principal.token) =>
  api.put(`/api/v1/timetable/classes/${classSectionId}/slots/${slot[slotKey]}`).set(bearer(token)).send({ subjectId });

beforeAll(async () => {
  [principal, sok, historyTeacher] = await Promise.all([staffUser('Principal'), staffUser('Teacher'), staffUser('Teacher')]);
  [math, history] = await Promise.all([subjectCode('MATH'), subjectCode('HISTORY')]);
  for (const s of await prisma.timeSlot.findMany()) slot[`${s.shift}-${s.dayOfWeek}-${s.period}`] = s.id;
  c7A = await makeClass(7);
  c8B = await makeClass(8);
  await assignTeacher(sok.staff.id, math.id, c7A.id);
  await assignTeacher(sok.staff.id, math.id, c8B.id);
  // MoEYS quota: MATH 2 lessons a week in grade 7 (small, to test it)
  const grade7 = await prisma.grade.findUniqueOrThrow({ where: { gradeNumber: 7 } });
  const quota = await api.patch(`/api/v1/subjects/${math.id}/grades/${grade7.id}`).set(bearer(principal.token)).send({ weeklyPeriods: 2 });
  expect(quota.status).toBe(200);
});

describe('golden rule 2: one lesson per class per slot', () => {
  it('placing a second subject in the same slot replaces the first', async () => {
    expect((await place(c7A.id, 'MORNING-1-1', math.id)).status).toBe(200);
    const replaced = await place(c7A.id, 'MORNING-1-1', history.id);
    expect(replaced.body.data.subject.code).toBe('HISTORY');
    expect(await prisma.timetableEntry.count({ where: { classSectionId: c7A.id, timeSlotId: slot['MORNING-1-1'] } })).toBe(1);
  });
});

describe('golden rule 1: a teacher is in one class at a time', () => {
  it('refuses Sok in 8B while he teaches 7A in that slot', async () => {
    const first = await place(c7A.id, 'MORNING-1-2', math.id);
    expect(first.body.data.staffProfile.id).toBe(sok.staff.id);
    const clash = await place(c8B.id, 'MORNING-1-2', math.id);
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('TEACHER_CLASH');
    expect(clash.body.details.otherClass).toBe(`7${c7A.sectionName}`);
  });

  it('refuses an assignment that would put a teacher in two classes at once', async () => {
    // 8B has HISTORY on Monday period 2 with no teacher yet; Sok is in 7A then
    expect((await place(c8B.id, 'MORNING-1-2', history.id)).body.data.staffProfile).toBeNull();
    const res = await api.post('/api/v1/assignments/subject-teacher').set(bearer(principal.token)).send({ staffId: sok.staff.id, subjectId: history.id, classSectionId: c8B.id });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TEACHER_CLASH');
  });

  it('gives existing lessons their teacher when the subject is assigned', async () => {
    await assignTeacher(historyTeacher.staff.id, history.id, c7A.id);
    const lesson = await prisma.timetableEntry.findFirstOrThrow({ where: { classSectionId: c7A.id, subjectId: history.id } });
    expect(lesson.staffProfileId).toBe(historyTeacher.staff.id);
  });
});

describe('shifts and quotas', () => {
  it('only allows a class in its own shift, and locks the shift once lessons exist', async () => {
    const wrong = await place(c7A.id, 'AFTERNOON-1-1', math.id);
    expect(wrong.body.code).toBe('WRONG_SHIFT');
    const change = await api.patch(`/api/v1/class-sections/${c7A.id}`).set(bearer(principal.token)).send({ shift: 'AFTERNOON' });
    expect(change.body.code).toBe('CLASS_HAS_TIMETABLE');
  });

  it('stops at the MoEYS weekly quota and reports it as met', async () => {
    expect((await place(c7A.id, 'MORNING-2-1', math.id)).status).toBe(200); // 2nd MATH lesson
    const third = await place(c7A.id, 'MORNING-3-1', math.id);
    expect(third.body.code).toBe('QUOTA_EXCEEDED');

    const grid = await api.get(`/api/v1/timetable/classes/${c7A.id}`).set(bearer(sok.token));
    expect(grid.body.data.quotas.find((q: { subject: { code: string } }) => q.subject.code === 'MATH')).toMatchObject({ weeklyPeriods: 2, scheduled: 2, status: 'MET' });
    expect(grid.body.data.summary).toMatchObject({ slots: 30, lessons: 3 });
  });

  it('lets only timetable managers place lessons', async () => {
    expect((await place(c7A.id, 'MORNING-4-1', history.id, sok.token)).status).toBe(403);
  });
});

describe('rooms', () => {
  it('lets a morning and an afternoon class share a room, but not two classes in one shift', async () => {
    const room = await api.post('/api/v1/rooms').set(bearer(principal.token)).send({ name: `Room ${uid()}`, capacity: 45 });
    expect(room.status).toBe(201);
    const morning = await makeClass(9);
    const afternoon = await makeClass(9);
    const morning2 = await makeClass(9);
    const setRoom = (id: string, body: object) => api.patch(`/api/v1/class-sections/${id}`).set(bearer(principal.token)).send({ roomId: room.body.data.id, ...body });

    expect((await setRoom(morning.id, {})).status).toBe(200);
    expect((await setRoom(afternoon.id, { shift: 'AFTERNOON' })).status).toBe(200);
    const taken = await setRoom(morning2.id, {});
    expect(taken.body.code).toBe('ROOM_SHIFT_TAKEN');
    expect((await api.delete(`/api/v1/rooms/${room.body.data.id}`).set(bearer(principal.token))).body.code).toBe('ROOM_IN_USE');
  });
});

describe('reading timetables', () => {
  it("shows a teacher's week across classes and a student's class week", async () => {
    const mine = await api.get('/api/v1/timetable/me').set(bearer(sok.token));
    expect(mine.body.data).toMatchObject({ type: 'TEACHER', lessonsPerWeek: 2 });

    const [student] = await makeStudentsIn(c7A, 1);
    const studentToken = await tokenFor((await makeLogin('Student', { studentId: student.id })).username);
    const week = await api.get('/api/v1/timetable/me').set(bearer(studentToken));
    expect(week.body.data).toMatchObject({ type: 'CLASS', classSection: { id: c7A.id, shift: 'MORNING' } });
    expect(week.body.data.days[0].slots[0].lesson.subject.code).toBe('HISTORY');
  });

  it('lists classes that are still missing quota lessons', async () => {
    const res = await api.get('/api/v1/timetable/quotas').set(bearer(principal.token));
    const row = res.body.data.classes.find((c: { classSectionId: string }) => c.classSectionId === c7A.id);
    expect(row.missing.find((m: { subject: string }) => m.subject === 'MATH')).toBeUndefined();
  });
});
