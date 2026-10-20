import { describe, expect, it } from 'vitest';
import { api, bearer, makeLogin, makeStaff, PASSWORD, prisma, tokenFor, uid } from '../helpers';

const login = (username: string, password: string) => api.post('/api/v1/auth/login').send({ username, password });

describe('login protection', () => {
  it('locks a username after 5 failed logins, even for the right password', async () => {
    const { username } = await makeLogin('Teacher', { staffId: (await makeStaff()).id });

    for (let i = 1; i <= 4; i++) expect((await login(username, 'wrong')).status).toBe(401);
    const fifth = await login(username, 'wrong');
    expect(fifth.status).toBe(429);
    expect(fifth.body.code).toBe('ACCOUNT_LOCKED');
    expect(fifth.headers['retry-after']).toBeDefined();

    const correct = await login(username, PASSWORD);
    expect(correct.status).toBe(429);
  });

  it('treats unknown usernames the same way, so a lock reveals nothing', async () => {
    const nobody = `nobody.${uid().toLowerCase()}`;
    for (let i = 1; i <= 4; i++) expect((await login(nobody, 'wrong')).status).toBe(401);
    expect((await login(nobody, 'wrong')).body.code).toBe('ACCOUNT_LOCKED');
  });

  it('records failed and successful logins in the audit log without the password', async () => {
    const { username, userId } = await makeLogin('Teacher', { staffId: (await makeStaff()).id });
    await login(username, 'wrong-password-123');
    await login(username, PASSWORD);
    const entries = await prisma.auditLog.findMany({ where: { entityId: userId, action: { in: ['LOGIN_FAILED', 'LOGIN_SUCCEEDED'] } } });
    expect(entries.map((e) => e.action).sort()).toEqual(['LOGIN_FAILED', 'LOGIN_SUCCEEDED']);
    expect(JSON.stringify(entries)).not.toContain('wrong-password-123');
  });
});

describe('password change', () => {
  it('revokes tokens issued before the change and returns a working new one', async () => {
    const { username } = await makeLogin('Teacher', { staffId: (await makeStaff()).id });
    const oldToken = await tokenFor(username);
    await new Promise((resolve) => setTimeout(resolve, 1100)); // token times are whole seconds

    const changed = await api
      .post('/api/v1/auth/change-password')
      .set(bearer(oldToken))
      .send({ currentPassword: PASSWORD, newPassword: 'Changed@98765' });
    expect(changed.status).toBe(200);

    const withOld = await api.get('/api/v1/auth/me').set(bearer(oldToken));
    expect(withOld.status).toBe(401);
    const withNew = await api.get('/api/v1/auth/me').set(bearer(changed.body.data.accessToken));
    expect(withNew.status).toBe(200);
    expect((await login(username, 'Changed@98765')).status).toBe(200);
  });

  it('rejects a wrong current password and a weak new one', async () => {
    const { username } = await makeLogin('Teacher', { staffId: (await makeStaff()).id });
    const token = await tokenFor(username);
    const wrong = await api.post('/api/v1/auth/change-password').set(bearer(token)).send({ currentPassword: 'nope', newPassword: 'Changed@98765' });
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
    const weak = await api.post('/api/v1/auth/change-password').set(bearer(token)).send({ currentPassword: PASSWORD, newPassword: 'short' });
    expect(weak.body.code).toBe('WEAK_PASSWORD');
  });
});
