import { beforeAll, describe, expect, it } from 'vitest';
import { api, bearer, makeLogin, makeStaff, makeStudent, prisma, staffUser } from '../helpers';

let admin: Awaited<ReturnType<typeof staffUser>>;
let registrar: Awaited<ReturnType<typeof staffUser>>;

beforeAll(async () => {
  [admin, registrar] = await Promise.all([staffUser('System Admin'), staffUser('Registrar')]);
});

describe('audit log', () => {
  it('records who changed what, with only the fields that changed', async () => {
    const student = await makeStudent();
    const res = await api.patch(`/api/v1/students/${student.id}`).set(bearer(registrar.token)).send({ latinName: 'Renamed Student' });
    expect(res.status).toBe(200);

    const log = await api.get(`/api/v1/audit-logs?entityType=Student&entityId=${student.id}&action=STUDENT_UPDATED`).set(bearer(admin.token));
    expect(log.body.data).toHaveLength(1);
    expect(log.body.data[0]).toMatchObject({
      actorUserId: registrar.userId,
      actorUsername: registrar.username,
      before: { latinName: student.latinName },
      after: { latinName: 'Renamed Student' },
    });
  });

  it('does not record an update that changed nothing', async () => {
    const student = await makeStudent();
    await api.patch(`/api/v1/students/${student.id}`).set(bearer(registrar.token)).send({ latinName: student.latinName });
    expect(await prisma.auditLog.count({ where: { entityId: student.id, action: 'STUDENT_UPDATED' } })).toBe(0);
  });

  it('never stores password hashes or temporary passwords', async () => {
    const { userId } = await makeLogin('Teacher', { staffId: (await makeStaff()).id });
    const reset = await api.post(`/api/v1/users/${userId}/reset-password`).set(bearer(admin.token)).send({});
    expect(reset.status).toBe(200);
    const temporaryPassword = reset.body.data.temporaryPassword as string;

    const entries = JSON.stringify(await prisma.auditLog.findMany({ where: { entityId: userId } }));
    expect(entries).toContain('PASSWORD_RESET');
    expect(entries).not.toContain(temporaryPassword);
    expect(entries).not.toMatch(/\$2[aby]\$/); // bcrypt hash prefix
  });

  it('is only readable with LIST_AUDIT_LOGS', async () => {
    expect((await api.get('/api/v1/audit-logs').set(bearer(registrar.token))).status).toBe(403);
    expect((await api.get('/api/v1/audit-logs').set(bearer(admin.token))).status).toBe(200);
  });
});
