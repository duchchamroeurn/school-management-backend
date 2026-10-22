import { beforeAll, describe, expect, it } from 'vitest';
import { api, bearer, staffUser, VILLAGES } from '../helpers';

let token: string;

beforeAll(async () => {
  token = (await staffUser('Teacher')).token;
});

const get = (path: string, query: Record<string, string> = {}) => api.get(`/api/v1/locations${path}`).query(query).set(bearer(token));

describe('gazetteer', () => {
  it('walks province › district › commune › village, for any signed-in user', async () => {
    expect((await get('/provinces')).body.data).toContainEqual({ code: '99', type: 'PROVINCE', khmerName: 'សាកល្បង', latinName: 'Sakalbang' });
    expect((await get('/provinces/99/districts')).body.data.map((d: { code: string }) => d.code)).toEqual(['9901']);
    expect((await get('/districts/9901/communes')).body.data.map((c: { type: string }) => c.type)).toEqual(['COMMUNE', 'SANGKAT']);
    expect((await get('/communes/990101/villages')).body.data.map((v: { code: string }) => v.code)).toEqual([VILLAGES.kandal, VILLAGES.tboung]);
    expect((await api.get('/api/v1/locations/provinces')).status).toBe(401);
  });

  it('gives a village with its full address', async () => {
    const res = await get(`/villages/${VILLAGES.cheung}`);
    expect(res.body.data).toMatchObject({ khmer: 'ភូមិជើង សង្កាត់ទួល ស្រុកទីមួយ ខេត្តសាកល្បង', latin: 'Cheung Village, Tuol Sangkat, Ti Muoy District, Sakalbang Province' });
  });

  it('finds villages by Khmer or Latin name', async () => {
    expect((await get('/villages', { search: 'tboung' })).body.data.map((v: { village: { code: string } }) => v.village.code)).toEqual([VILLAGES.tboung]);
    expect((await get('/villages', { search: 'ជើង' })).body.data[0].village.code).toBe(VILLAGES.cheung);
    expect((await get('/villages', { search: 'x' })).status).toBe(400);
  });

  it('tells a wrong code from an unknown one', async () => {
    expect((await get('/provinces/9/districts')).status).toBe(400);
    expect((await get('/provinces/98/districts')).status).toBe(404);
    expect((await get('/villages/99019999')).status).toBe(404);
  });
});
