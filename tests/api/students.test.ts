import { beforeAll, describe, expect, it } from 'vitest';
import { api, bearer, makeClass, makeStudentsIn, staffUser, uid } from '../helpers';

let principal: Awaited<ReturnType<typeof staffUser>>;
let registrar: Awaited<ReturnType<typeof staffUser>>;
let teacher: Awaited<ReturnType<typeof staffUser>>;

const newStudent = (overrides: object = {}) => {
  const id = uid();
  return {
    birthCertificateNo: `BC-${id}`,
    khmerName: 'សុខ ដារ៉ា',
    latinName: `Sok Dara ${id.replace(/\d/g, '')}`,
    dateOfBirth: '2013-05-01',
    gender: 'F',
    ...overrides,
  };
};
const create = (body: object, token = registrar.token) => api.post('/api/v1/students').set(bearer(token)).send(body);

beforeAll(async () => {
  [principal, registrar, teacher] = await Promise.all([staffUser('Principal'), staffUser('Registrar'), staffUser('Teacher')]);
});

describe('registering students', () => {
  it('gives a new student an id and the ENROLLED status', async () => {
    const res = await create(newStudent());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'ENROLLED', khmerName: 'សុខ ដារ៉ា' });
    expect(res.body.data.studentIdentifier).toBeTruthy();
  });

  it('refuses a birth certificate already registered, however it is written', async () => {
    const first = await create(newStudent({ birthCertificateNo: '៧៧៧/២០១៣' }));
    expect(first.status).toBe(201);
    expect(first.body.data.birthCertificateNo).toBe('777/2013');

    // Same number in Latin digits, with spaces
    const again = await create(newStudent({ birthCertificateNo: '777 / 2013' }));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('DUPLICATE_STUDENT');
    expect(again.body.details.existingStudentId).toBe(first.body.data.id);
  });

  it('checks names and age', async () => {
    const latinKhmerName = await create(newStudent({ khmerName: 'Sok Dara' }));
    expect(latinKhmerName.status).toBe(400);
    expect(latinKhmerName.body.details.field).toBe('khmerName');

    const tooYoung = await create(newStudent({ dateOfBirth: '2024-01-01' }));
    expect(tooYoung.status).toBe(400);
    expect(tooYoung.body.details.field).toBe('dateOfBirth');
  });

  it('is not for teachers', async () => {
    expect((await create(newStudent(), teacher.token)).status).toBe(403);
  });
});

describe('finding and changing students', () => {
  it('finds a student by name or student id', async () => {
    const student = (await create(newStudent({ latinName: 'Chan Sophea Searchable' }))).body.data;
    const byName = await api.get('/api/v1/students').query({ search: 'Searchable' }).set(bearer(teacher.token));
    expect(byName.status).toBe(200);
    expect(byName.body.data.map((s: { id: string }) => s.id)).toContain(student.id);

    const byId = await api.get('/api/v1/students').query({ search: student.studentIdentifier }).set(bearer(teacher.token));
    expect(byId.body.data.map((s: { id: string }) => s.id)).toEqual([student.id]);
  });

  it('updates a student and records the change', async () => {
    const student = (await create(newStudent())).body.data;
    const res = await api.patch(`/api/v1/students/${student.id}`).set(bearer(registrar.token)).send({ primarySchoolOrigin: 'Wat Phnom Primary' });
    expect(res.status).toBe(200);
    expect(res.body.data.primarySchoolOrigin).toBe('Wat Phnom Primary');

    const history = await api.get('/api/v1/audit-logs').query({ entityId: student.id }).set(bearer(principal.token));
    expect(history.body.data.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(['STUDENT_CREATED', 'STUDENT_UPDATED']));
  });
});

describe('deleting students', () => {
  it('deletes a student registered by mistake, but only with DELETE_STUDENT', async () => {
    const student = (await create(newStudent())).body.data;
    expect((await api.delete(`/api/v1/students/${student.id}`).set(bearer(registrar.token))).status).toBe(403);
    expect((await api.delete(`/api/v1/students/${student.id}`).set(bearer(principal.token))).status).toBe(204);
    expect((await api.get(`/api/v1/students/${student.id}`).set(bearer(principal.token))).status).toBe(404);
  });

  it('keeps a student who has been enrolled: their status changes instead', async () => {
    const [student] = await makeStudentsIn(await makeClass(9), 1);
    const res = await api.delete(`/api/v1/students/${student!.id}`).set(bearer(principal.token));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STUDENT_HAS_HISTORY');

    const dropped = await api.patch(`/api/v1/students/${student!.id}`).set(bearer(registrar.token)).send({ status: 'DROPPED_OUT' });
    expect(dropped.body.data.status).toBe('DROPPED_OUT');
  });
});
