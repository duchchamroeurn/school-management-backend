import { beforeAll, describe, expect, it } from 'vitest';
import { api, bearer, makeStudent, prisma, staffUser } from '../helpers';

let registrar: Awaited<ReturnType<typeof staffUser>>;
beforeAll(async () => {
  registrar = await staffUser('Registrar');
});

const primaries = (studentId: string) => prisma.studentGuardian.findMany({ where: { studentId, isPrimaryContact: true }, include: { guardian: true } });
const addGuardian = (studentId: string, body: Record<string, unknown>) => api.post(`/api/v1/students/${studentId}/guardians`).set(bearer(registrar.token)).send(body);

describe('guardians', () => {
  it('keeps exactly one primary contact per student', async () => {
    const student = await makeStudent();
    const mother = await addGuardian(student.id, { relationship: 'MOTHER', guardian: { khmerName: 'ម្តាយ', latinName: 'Mother', phone: '+855 12 345 678' } });
    expect(mother.body.data).toMatchObject({ isPrimaryContact: true, guardian: { phone: '012345678' } });

    const father = await addGuardian(student.id, { relationship: 'FATHER', isPrimaryContact: true, guardian: { khmerName: 'ឪពុក', latinName: 'Father' } });
    expect((await primaries(student.id)).map((p) => p.guardian.latinName)).toEqual(['Father']);

    await api.delete(`/api/v1/students/${student.id}/guardians/${father.body.data.guardianId}`).set(bearer(registrar.token));
    expect((await primaries(student.id)).map((p) => p.guardian.latinName)).toEqual(['Mother']);
  });

  it('shares one guardian between siblings and updates their contact once', async () => {
    const [older, younger] = [await makeStudent(), await makeStudent()];
    const link = await addGuardian(older.id, { relationship: 'MOTHER', guardian: { khmerName: 'ម្តាយ', latinName: 'Shared Mother' } });
    const guardianId = link.body.data.guardianId;
    expect((await addGuardian(younger.id, { relationship: 'MOTHER', guardianId })).status).toBe(201);
    expect((await addGuardian(younger.id, { relationship: 'MOTHER', guardianId })).body.code).toBe('GUARDIAN_ALREADY_LINKED');

    await api.patch(`/api/v1/guardians/${guardianId}`).set(bearer(registrar.token)).send({ phone: '097 111 2222' });
    const seen = await api.get(`/api/v1/students/${younger.id}/guardians`).set(bearer(registrar.token));
    expect(seen.body.data[0].guardian.phone).toBe('0971112222');

    expect((await api.delete(`/api/v1/guardians/${guardianId}`).set(bearer(registrar.token))).body.code).toBe('GUARDIAN_HAS_STUDENTS');
  });
});
