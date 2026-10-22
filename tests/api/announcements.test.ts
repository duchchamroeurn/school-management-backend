import { beforeAll, describe, expect, it } from 'vitest';
import { api, assignTeacher, bearer, makeClass, makeLogin, makeStudentsIn, prisma, staffUser, subjectCode, tokenFor } from '../helpers';

let principal: Awaited<ReturnType<typeof staffUser>>;
let registrar: Awaited<ReturnType<typeof staffUser>>;
let homeroom: Awaited<ReturnType<typeof staffUser>>; // homeroom teacher of class X
let mathTeacher: Awaited<ReturnType<typeof staffUser>>; // teaches MATH in class X
let otherTeacher: Awaited<ReturnType<typeof staffUser>>; // teaches nothing in class X
let studentX: string; // token of a student in class X
let studentY: string; // token of a student in class Y
let classX: { id: string };
let classY: { id: string };
let teacherRoleId: string;

const post = (body: object, token = principal.token) => api.post('/api/v1/announcements').set(bearer(token)).send(body);
const feedIds = async (token: string) =>
  ((await api.get('/api/v1/announcements/feed').query({ pageSize: 50 }).set(bearer(token))).body.data as { id: string }[]).map((a) => a.id);
const unread = async (token: string) => (await api.get('/api/v1/announcements/feed/unread-count').set(bearer(token))).body.data.unread as number;
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();
const anHourAgo = () => new Date(Date.now() - 3_600_000).toISOString();

async function studentToken(classSection: { id: string; academicYearId: string }) {
  const [student] = await makeStudentsIn(classSection, 1);
  const { username } = await makeLogin('Student', { studentId: student!.id });
  return tokenFor(username);
}

beforeAll(async () => {
  [principal, registrar, homeroom, mathTeacher, otherTeacher] = await Promise.all([
    staffUser('Principal'),
    staffUser('Registrar'),
    staffUser('Teacher'),
    staffUser('Teacher'),
    staffUser('Teacher'),
  ]);
  const x = await makeClass(10, { homeroomTeacherId: homeroom.staff.id });
  const y = await makeClass(10);
  [classX, classY] = [x, y];
  await assignTeacher(mathTeacher.staff.id, (await subjectCode('MATH')).id, x.id);
  [studentX, studentY] = await Promise.all([studentToken(x), studentToken(y)]);
  teacherRoleId = (await prisma.role.findUniqueOrThrow({ where: { latinName: 'Teacher' } })).id;
});

describe('who sees an announcement', () => {
  it('EVERYONE: every signed-in user', async () => {
    const res = await post({ title: 'School closed Monday', body: 'Water festival.\nSee you Tuesday.', audience: 'EVERYONE' });
    expect(res.status).toBe(201);
    expect(res.body.data.body).toBe('Water festival.\nSee you Tuesday.');
    for (const token of [otherTeacher.token, studentY, registrar.token]) {
      expect(await feedIds(token)).toContain(res.body.data.id);
    }
  });

  it('ROLES: only logins with one of the roles', async () => {
    const res = await post({ title: 'Staff meeting', body: 'Friday 16:00 in the library.', audience: 'ROLES', roleIds: [teacherRoleId] });
    expect(res.status).toBe(201);
    expect(res.body.data.roles.map((r: { latinName: string }) => r.latinName)).toEqual(['Teacher']);
    expect(await feedIds(otherTeacher.token)).toContain(res.body.data.id);
    expect(await feedIds(studentX)).not.toContain(res.body.data.id);
    expect(await feedIds(registrar.token)).not.toContain(res.body.data.id);
  });

  it('CLASSES: the class’s students and its homeroom and subject teachers', async () => {
    const res = await post({ title: 'Grade 10 exam', body: 'Bring a calculator.', audience: 'CLASSES', classSectionIds: [classX.id] });
    expect(res.status).toBe(201);
    const id = res.body.data.id;
    for (const token of [studentX, homeroom.token, mathTeacher.token]) expect(await feedIds(token)).toContain(id);
    for (const token of [studentY, otherTeacher.token]) expect(await feedIds(token)).not.toContain(id);

    // The recipient count follows the same rules: one student login and two teachers
    const managed = (await api.get('/api/v1/announcements').set(bearer(principal.token))).body.data.find((a: { id: string }) => a.id === id);
    expect(managed).toMatchObject({ status: 'ACTIVE', recipients: 3, readCount: 0 });
  });

  it('hides it before publishAt and after expiresAt', async () => {
    const scheduled = (await post({ title: 'Next term', body: 'Soon.', audience: 'EVERYONE', publishAt: inAnHour() })).body.data;
    const expired = (await post({ title: 'Old news', body: 'Over.', audience: 'EVERYONE', publishAt: new Date(Date.now() - 7_200_000).toISOString(), expiresAt: anHourAgo() })).body.data;
    const ids = await feedIds(studentY);
    expect(ids).not.toContain(scheduled.id);
    expect(ids).not.toContain(expired.id);

    const list = (await api.get('/api/v1/announcements').query({ status: 'SCHEDULED' }).set(bearer(principal.token))).body.data;
    expect(list.map((a: { id: string }) => a.id)).toContain(scheduled.id);
    expect((await api.get(`/api/v1/announcements/${scheduled.id}`).set(bearer(studentY))).status).toBe(404);
    expect((await api.get(`/api/v1/announcements/${scheduled.id}`).set(bearer(principal.token))).status).toBe(200);
  });

  it('lists pinned, then important, before the rest', async () => {
    const pinned = (await post({ title: 'Read me first', body: 'Pinned.', audience: 'EVERYONE', pinned: true })).body.data;
    const important = (await post({ title: 'Urgent', body: 'Important.', audience: 'EVERYONE', priority: 'IMPORTANT' })).body.data;
    const ids = await feedIds(studentY);
    expect(ids.indexOf(pinned.id)).toBe(0);
    expect(ids.indexOf(important.id)).toBe(1);
  });
});

describe('reading', () => {
  it('counts unread, and marks one or all as read', async () => {
    const token = studentY;
    const before = await unread(token);
    expect(before).toBeGreaterThan(0);

    const [first] = await feedIds(token);
    expect((await api.post(`/api/v1/announcements/${first}/read`).set(bearer(token))).status).toBe(204);
    // Marking twice is harmless
    expect((await api.post(`/api/v1/announcements/${first}/read`).set(bearer(token))).status).toBe(204);
    expect(await unread(token)).toBe(before - 1);

    const feed = (await api.get('/api/v1/announcements/feed').set(bearer(token))).body.data;
    expect(feed.find((a: { id: string }) => a.id === first).read).toBe(true);

    const all = await api.post('/api/v1/announcements/feed/read-all').set(bearer(token));
    expect(all.body.data.marked).toBe(before - 1);
    expect(await unread(token)).toBe(0);
  });

  it('can’t mark or open an announcement that isn’t for the user', async () => {
    const forX = (await post({ title: 'Class X trip', body: 'Bring water.', audience: 'CLASSES', classSectionIds: [classX.id] })).body.data;
    expect((await api.post(`/api/v1/announcements/${forX.id}/read`).set(bearer(studentY))).status).toBe(404);
    expect((await api.get(`/api/v1/announcements/${forX.id}`).set(bearer(studentY))).status).toBe(404);
    expect((await api.get(`/api/v1/announcements/${forX.id}`).set(bearer(studentX))).status).toBe(200);
  });
});

describe('managing', () => {
  it('is only for MANAGE_ANNOUNCEMENTS', async () => {
    expect((await post({ title: 'Hi', body: 'Hello.', audience: 'EVERYONE' }, homeroom.token)).status).toBe(403);
    expect((await api.get('/api/v1/announcements').set(bearer(homeroom.token))).status).toBe(403);
  });

  it('checks the audience and dates', async () => {
    const noRoles = await post({ title: 'T', body: 'B', audience: 'ROLES' });
    expect(noRoles.status).toBe(400);
    expect(noRoles.body.details.field).toBe('roleIds');

    const unknownClass = await post({ title: 'T', body: 'B', audience: 'CLASSES', classSectionIds: ['00000000-0000-0000-0000-000000000000'] });
    expect(unknownClass.status).toBe(400);
    expect(unknownClass.body.details.field).toBe('classSectionIds');

    const backwards = await post({ title: 'T', body: 'B', audience: 'EVERYONE', publishAt: inAnHour(), expiresAt: anHourAgo() });
    expect(backwards.status).toBe(400);
    expect(backwards.body.details.field).toBe('expiresAt');

    const badDate = await post({ title: 'T', body: 'B', audience: 'EVERYONE', publishAt: '2026-11-01' });
    expect(badDate.body.details.field).toBe('publishAt');
  });

  it('changes the audience, deletes, and audits each step', async () => {
    const created = (await post({ title: 'Sports day', body: 'Wear white.', audience: 'CLASSES', classSectionIds: [classX.id] })).body.data;
    expect(await feedIds(studentY)).not.toContain(created.id);

    const moved = await api.patch(`/api/v1/announcements/${created.id}`).set(bearer(principal.token)).send({ classSectionIds: [classY.id] });
    expect(moved.status).toBe(200);
    expect(moved.body.data.classes.map((c: { id: string }) => c.id)).toEqual([classY.id]);
    expect(await feedIds(studentY)).toContain(created.id);
    expect(await feedIds(studentX)).not.toContain(created.id);

    expect((await api.delete(`/api/v1/announcements/${created.id}`).set(bearer(principal.token))).status).toBe(204);
    expect(await feedIds(studentY)).not.toContain(created.id);

    const actions = (await prisma.auditLog.findMany({ where: { entityId: created.id }, orderBy: { createdAt: 'asc' } })).map((a) => a.action);
    expect(actions).toEqual(['ANNOUNCEMENT_CREATED', 'ANNOUNCEMENT_UPDATED', 'ANNOUNCEMENT_DELETED']);
  });
});
