import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, bearer, makeClass, prisma, staffUser } from '../helpers';

// The calendar is school-wide, so each test uses dates no other test file touches (2031, 2038–2040, March 2027).
let principal: Awaited<ReturnType<typeof staffUser>>;
let teacher: Awaited<ReturnType<typeof staffUser>>;

const calendar = (from: string, to: string, token = principal.token) =>
  api.get('/api/v1/school-calendar').query({ from, to }).set(bearer(token));
const createEvent = (body: object, token = principal.token) => api.post('/api/v1/school-calendar/events').set(bearer(token)).send(body);
const dayOf = async (date: string) => (await calendar(date, date)).body.data.days[0];

beforeAll(async () => {
  [principal, teacher] = await Promise.all([staffUser('Principal'), staffUser('Teacher')]);
});

describe('school week', () => {
  it('starts as Monday–Saturday mornings and Monday–Friday afternoons', async () => {
    const res = await api.get('/api/v1/school-calendar/week').set(bearer(teacher.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(7);
    expect(res.body.data[5]).toMatchObject({ dayOfWeek: 6, morning: true, afternoon: false });
    expect(res.body.data[6]).toMatchObject({ dayOfWeek: 7, morning: false, afternoon: false });
  });

  it('marks school days from the week (2031-03-03 is a Monday, 03-09 a Sunday)', async () => {
    const res = await calendar('2031-03-03', '2031-03-09');
    expect(res.status).toBe(200);
    const days = res.body.data.days;
    expect(days[0]).toMatchObject({ date: '2031-03-03', dayOfWeek: 1, morning: true, afternoon: true });
    expect(days[5]).toMatchObject({ dayOfWeek: 6, morning: true, afternoon: false });
    expect(days[6]).toMatchObject({ dayOfWeek: 7, morning: false, afternoon: false });
    expect(res.body.data.summary).toMatchObject({ days: 7, schoolDays: 6, morningDays: 6, afternoonDays: 5 });
  });

  it('refuses a week that is incomplete or has no school at all', async () => {
    const six = [1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, morning: true, afternoon: true }));
    const incomplete = await api.put('/api/v1/school-calendar/week').set(bearer(principal.token)).send({ weekdays: six });
    expect(incomplete.status).toBe(400);
    expect(incomplete.body.details.field).toBe('weekdays');

    const none = [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => ({ dayOfWeek, morning: false, afternoon: false }));
    expect((await api.put('/api/v1/school-calendar/week').set(bearer(principal.token)).send({ weekdays: none })).status).toBe(400);
  });

  it('saves a changed week, audits it, and only for MANAGE_SCHOOL_CALENDAR', async () => {
    const original = (await api.get('/api/v1/school-calendar/week').set(bearer(principal.token))).body.data;
    const withSaturdayAfternoon = original.map((d: { dayOfWeek: number }) => ({ ...d, afternoon: d.dayOfWeek <= 6 }));

    const denied = await api.put('/api/v1/school-calendar/week').set(bearer(teacher.token)).send({ weekdays: withSaturdayAfternoon });
    expect(denied.status).toBe(403);

    try {
      const res = await api.put('/api/v1/school-calendar/week').set(bearer(principal.token)).send({ weekdays: withSaturdayAfternoon });
      expect(res.status).toBe(200);
      expect(res.body.data[5]).toMatchObject({ dayOfWeek: 6, afternoon: true });
      const entry = await prisma.auditLog.findFirst({ where: { action: 'SCHOOL_WEEK_UPDATED' }, orderBy: { createdAt: 'desc' } });
      expect(entry?.after).toEqual({ 6: { morning: true, afternoon: true } });
    } finally {
      // The week is shared by every test file
      await api.put('/api/v1/school-calendar/week').set(bearer(principal.token)).send({ weekdays: original });
    }
  });
});

describe('calendar entries', () => {
  it('a public holiday closes the school, even if closesSchool is sent as false', async () => {
    const res = await createEvent({ type: 'PUBLIC_HOLIDAY', khmerName: 'ថ្ងៃឈប់សម្រាក', latinName: 'Test holiday', startDate: '2031-03-05', endDate: '2031-03-05', closesSchool: false });
    expect(res.status).toBe(201);
    expect(res.body.data.closesSchool).toBe(true);

    const week = (await calendar('2031-03-03', '2031-03-09')).body.data;
    expect(week.days[2]).toMatchObject({ date: '2031-03-05', morning: false, afternoon: false });
    expect(week.days[2].events[0]).toMatchObject({ id: res.body.data.id, type: 'PUBLIC_HOLIDAY' });
    expect(week.summary).toMatchObject({ schoolDays: 5, closedSchoolDays: 1 });
  });

  it('an event can close a single shift', async () => {
    const res = await createEvent({ type: 'SCHOOL_EVENT', khmerName: 'ប្រជុំគ្រូ', startDate: '2031-03-04', endDate: '2031-03-04', shift: 'AFTERNOON', closesSchool: true });
    expect(res.status).toBe(201);
    expect(await dayOf('2031-03-04')).toMatchObject({ morning: true, afternoon: false });
  });

  it('a make-up day opens a day off, but a holiday on the same day still wins', async () => {
    const makeup = await createEvent({ type: 'MAKEUP_DAY', khmerName: 'ថ្ងៃសិក្សាសង', startDate: '2031-03-09', endDate: '2031-03-09', shift: 'MORNING', closesSchool: true });
    expect(makeup.status).toBe(201);
    expect(makeup.body.data.closesSchool).toBe(false);
    expect(await dayOf('2031-03-09')).toMatchObject({ morning: true, afternoon: false });

    await createEvent({ type: 'SCHOOL_BREAK', khmerName: 'វិស្សមកាល', startDate: '2031-03-09', endDate: '2031-03-15' });
    expect(await dayOf('2031-03-09')).toMatchObject({ morning: false, afternoon: false });
  });

  it('repeats a fixed-date holiday every year from its first year on', async () => {
    const res = await createEvent({ type: 'PUBLIC_HOLIDAY', khmerName: 'ថ្ងៃបុណ្យឯករាជ្យ', startDate: '2039-11-09', endDate: '2039-11-09', recursYearly: true });
    expect(res.status).toBe(201);

    const later = await dayOf('2040-11-09'); // a Friday
    expect(later).toMatchObject({ morning: false, afternoon: false });
    expect(later.events.map((e: { id: string }) => e.id)).toContain(res.body.data.id);

    const before = await dayOf('2038-11-09'); // a Tuesday, before the holiday was first kept
    expect(before).toMatchObject({ morning: true, events: [] });
  });

  it('refuses invalid entries', async () => {
    const recurringBreak = await createEvent({ type: 'SCHOOL_BREAK', khmerName: 'វិស្សមកាល', startDate: '2031-04-01', endDate: '2031-04-10', recursYearly: true });
    expect(recurringBreak.status).toBe(400);
    expect(recurringBreak.body.details.field).toBe('recursYearly');

    const backwards = await createEvent({ type: 'SCHOOL_EVENT', khmerName: 'ប្រឡង', startDate: '2031-04-10', endDate: '2031-04-01' });
    expect(backwards.status).toBe(400);
    expect(backwards.body.details.field).toBe('endDate');

    const missingName = await createEvent({ type: 'SCHOOL_EVENT', startDate: '2031-04-01', endDate: '2031-04-01' });
    expect(missingName.body.details.field).toBe('khmerName');

    const tooLong = await calendar('2031-01-01', '2032-12-31');
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.details.field).toBe('to');
  });

  it('lets teachers read the calendar but not change it', async () => {
    expect((await calendar('2031-03-03', '2031-03-09', teacher.token)).status).toBe(200);
    const denied = await createEvent({ type: 'SCHOOL_EVENT', khmerName: 'ប្រឡង', startDate: '2031-05-01', endDate: '2031-05-01' }, teacher.token);
    expect(denied.status).toBe(403);
  });

  it('updates and deletes an entry, with audit entries', async () => {
    const created = (await createEvent({ type: 'SCHOOL_EVENT', khmerName: 'ពិធីបុណ្យ', startDate: '2031-06-02', endDate: '2031-06-02' })).body.data;
    expect(await dayOf('2031-06-02')).toMatchObject({ morning: true });

    const updated = await api.patch(`/api/v1/school-calendar/events/${created.id}`).set(bearer(principal.token)).send({ closesSchool: true });
    expect(updated.status).toBe(200);
    expect(await dayOf('2031-06-02')).toMatchObject({ morning: false });

    // Turning it into a make-up day can't keep it closing the school
    const makeup = await api.patch(`/api/v1/school-calendar/events/${created.id}`).set(bearer(principal.token)).send({ type: 'MAKEUP_DAY' });
    expect(makeup.body.data.closesSchool).toBe(false);

    expect((await api.delete(`/api/v1/school-calendar/events/${created.id}`).set(bearer(principal.token))).status).toBe(204);
    expect((await api.delete(`/api/v1/school-calendar/events/${created.id}`).set(bearer(principal.token))).status).toBe(404);

    const actions = (await prisma.auditLog.findMany({ where: { entityId: created.id }, orderBy: { createdAt: 'asc' } })).map((a) => a.action);
    expect(actions).toEqual(['CALENDAR_EVENT_CREATED', 'CALENDAR_EVENT_UPDATED', 'CALENDAR_EVENT_UPDATED', 'CALENDAR_EVENT_DELETED']);
  });

  it('lists entries overlapping a range, plus yearly holidays', async () => {
    const res = await api.get('/api/v1/school-calendar/events').query({ from: '2031-03-01', to: '2031-03-31' }).set(bearer(teacher.token));
    expect(res.status).toBe(200);
    const names = res.body.data.map((e: { khmerName: string }) => e.khmerName);
    expect(names).toEqual(expect.arrayContaining(['ថ្ងៃឈប់សម្រាក', 'ប្រជុំគ្រូ', 'វិស្សមកាល', 'ថ្ងៃបុណ្យឯករាជ្យ']));
  });
});

describe('attendance follows the calendar', () => {
  let classId: string;
  let holidayId: string;

  beforeAll(async () => {
    classId = (await makeClass(9)).id; // morning shift, in 2026-2027
    holidayId = (await createEvent({ type: 'PUBLIC_HOLIDAY', khmerName: 'ថ្ងៃឈប់', latinName: 'March test holiday', startDate: '2027-03-10', endDate: '2027-03-10' })).body.data.id;
  });

  afterAll(async () => {
    await api.delete(`/api/v1/school-calendar/events/${holidayId}`).set(bearer(principal.token));
  });

  const sheet = (date: string) => api.get(`/api/v1/attendance/class-sections/${classId}`).query({ date }).set(bearer(principal.token));

  it('says when the class has no school: a holiday, or a day the week has none', async () => {
    const holiday = await sheet('2027-03-10');
    expect(holiday.status).toBe(200);
    expect(holiday.body.data.schoolDay).toEqual({ open: false, closedBy: expect.objectContaining({ id: holidayId, type: 'PUBLIC_HOLIDAY' }) });

    expect((await sheet('2027-03-14')).body.data.schoolDay).toEqual({ open: false, closedBy: null }); // a Sunday
    expect((await sheet('2027-03-11')).body.data.schoolDay).toEqual({ open: true, closedBy: null });
  });
});
