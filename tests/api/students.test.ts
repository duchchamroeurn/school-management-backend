import { beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { api, bearer, image, makeClass, makeStudentsIn, PDF, staffUser, uid, VILLAGES } from '../helpers';

let principal: Awaited<ReturnType<typeof staffUser>>;
let registrar: Awaited<ReturnType<typeof staffUser>>;
let teacher: Awaited<ReturnType<typeof staffUser>>;
let photo: Buffer;

const newStudent = (overrides: Record<string, string | undefined> = {}) => {
  const id = uid();
  return {
    birthCertificateNo: `BC-${id}`,
    khmerName: 'សុខ ដារ៉ា',
    latinName: `Sok Dara ${id.replace(/\d/g, '')}`,
    dateOfBirth: '2013-05-01',
    gender: 'F',
    birthPlaceVillageCode: VILLAGES.kandal,
    addressVillageCode: VILLAGES.cheung,
    ...overrides,
  };
};

type Files = { photo?: Buffer | null; birthCertificateScan?: Buffer | null };

// Registration is multipart/form-data: text fields plus the two documents
const create = (body: Record<string, string | undefined>, token = registrar.token, files: Files = {}) => {
  const req = api.post('/api/v1/students').set(bearer(token));
  for (const [field, value] of Object.entries(body)) if (value !== undefined) req.field(field, value);
  const photoFile = files.photo === undefined ? photo : files.photo;
  const scanFile = files.birthCertificateScan === undefined ? PDF : files.birthCertificateScan;
  if (photoFile) req.attach('photo', photoFile, 'photo.jpg');
  if (scanFile) req.attach('birthCertificateScan', scanFile, 'scan.pdf');
  return req;
};

beforeAll(async () => {
  [principal, registrar, teacher] = await Promise.all([staffUser('Principal'), staffUser('Registrar'), staffUser('Teacher')]);
  photo = await image(800, 760);
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

  it('records place of birth and address as gazetteer villages, written out in Khmer and Latin', async () => {
    const res = await create(newStudent({ addressHouseNo: '12B', addressStreet: '271' }));
    expect(res.status).toBe(201);
    expect(res.body.data.birthPlace).toMatchObject({
      village: { code: VILLAGES.kandal },
      commune: { code: '990101', type: 'COMMUNE' },
      district: { code: '9901', type: 'DISTRICT' },
      province: { code: '99', type: 'PROVINCE' },
      khmer: 'ភូមិកណ្ដាល ឃុំព្រែក ស្រុកទីមួយ ខេត្តសាកល្បង',
    });
    expect(res.body.data.address.khmer).toBe('ផ្ទះលេខ12B ផ្លូវ271 ភូមិជើង សង្កាត់ទួល ស្រុកទីមួយ ខេត្តសាកល្បង');
    expect(res.body.data.address.latin).toBe('No. 12B, St. 271, Cheung Village, Tuol Sangkat, Ti Muoy District, Sakalbang Province');
  });

  it('records the parents, as text fields of the form', async () => {
    const res = await create(
      newStudent({ fatherName: 'សុខ ចាន់', fatherOccupation: 'កសិករ', isFatherDeceased: 'true', motherName: 'ម៉ៅ ស្រីនី', motherOccupation: 'លក់ដូរ' }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      fatherName: 'សុខ ចាន់',
      fatherOccupation: 'កសិករ',
      isFatherDeceased: true,
      motherName: 'ម៉ៅ ស្រីនី',
      motherOccupation: 'លក់ដូរ',
      isMotherDeceased: false,
    });

    const updated = await api.patch(`/api/v1/students/${res.body.data.id}`).set(bearer(registrar.token)).send({ isMotherDeceased: true, fatherOccupation: null });
    expect(updated.body.data).toMatchObject({ isMotherDeceased: true, fatherOccupation: null });

    const wrong = await create(newStudent({ isFatherDeceased: 'yes' }));
    expect(wrong.status).toBe(400);
    expect(wrong.body.details.field).toBe('isFatherDeceased');
  });

  it('requires both addresses, as codes of villages that exist', async () => {
    const noBirthPlace = await create(newStudent({ birthPlaceVillageCode: undefined }));
    expect(noBirthPlace.status).toBe(400);
    expect(noBirthPlace.body.details.field).toBe('birthPlaceVillageCode');

    const badFormat = await create(newStudent({ addressVillageCode: '9901' }));
    expect(badFormat.status).toBe(400);
    expect(badFormat.body.details.field).toBe('addressVillageCode');

    const unknown = await create(newStudent({ addressVillageCode: '99019999' }));
    expect(unknown.status).toBe(400);
    expect(unknown.body.details.field).toBe('addressVillageCode');
  });
});

describe('registry documents (4x4 photo, birth certificate scan)', () => {
  it('requires both documents', async () => {
    const noPhoto = await create(newStudent(), registrar.token, { photo: null });
    expect(noPhoto.status).toBe(400);
    expect(noPhoto.body.details.field).toBe('photo');

    const noScan = await create(newStudent(), registrar.token, { birthCertificateScan: null });
    expect(noScan.status).toBe(400);
    expect(noScan.body.details.field).toBe('birthCertificateScan');
  });

  it('stores the photo as a 472×472 JPEG, served only to users who may view students', async () => {
    const student = (await create(newStudent(), registrar.token, { photo: await image(900, 840, 'png') })).body.data;
    expect(student.photo).toMatchObject({ contentType: 'image/jpeg', url: `/api/v1/students/${student.id}/photo` });

    const res = await api.get(student.photo.url).set(bearer(teacher.token)).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toBe('private, no-cache');
    const meta = await sharp(res.body as Buffer).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 472, 472]);

    // Unchanged since last time: nothing is re-sent
    const again = await api.get(student.photo.url).set(bearer(teacher.token)).set('If-None-Match', res.headers.etag);
    expect(again.status).toBe(304);

    expect((await api.get(student.photo.url)).status).toBe(401);
  });

  it('refuses photos that are not a usable 4x4', async () => {
    const portrait = await create(newStudent(), registrar.token, { photo: await image(600, 800) });
    expect(portrait.status).toBe(400);
    expect(portrait.body.code).toBe('PHOTO_NOT_SQUARE');

    const tiny = await create(newStudent(), registrar.token, { photo: await image(200, 200) });
    expect(tiny.body.code).toBe('PHOTO_TOO_SMALL');

    const pdf = await create(newStudent(), registrar.token, { photo: PDF });
    expect(pdf.body.code).toBe('FILE_TYPE_NOT_ALLOWED');
  });

  it('accepts the birth certificate as PDF or image, nothing else', async () => {
    const scanned = await create(newStudent(), registrar.token, { birthCertificateScan: await image(1200, 800) });
    expect(scanned.status).toBe(201);
    expect(scanned.body.data.birthCertificateScan.contentType).toBe('image/jpeg');

    const text = await create(newStudent(), registrar.token, { birthCertificateScan: Buffer.from('not a document') });
    expect(text.status).toBe(400);
    expect(text.body).toMatchObject({ code: 'FILE_TYPE_NOT_ALLOWED', details: { field: 'birthCertificateScan' } });
  });

  it('refuses files in other fields', async () => {
    const res = await create(newStudent()).attach('passport', PDF, 'passport.pdf');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'UNEXPECTED_FILE', details: { field: 'passport' } });
  });

  it('replaces the photo, keeping the change in the audit log', async () => {
    const student = (await create(newStudent())).body.data;
    const res = await api
      .put(`/api/v1/students/${student.id}/photo`)
      .set(bearer(registrar.token))
      .attach('photo', await image(500, 500, 'png'), 'new.png');
    expect(res.status).toBe(200);
    expect(res.body.data.photo.id).not.toBe(student.photo.id);
    expect((await api.get(res.body.data.photo.url).set(bearer(registrar.token))).status).toBe(200);

    const history = await api.get('/api/v1/audit-logs').query({ entityId: student.id }).set(bearer(principal.token));
    expect(history.body.data.map((a: { action: string }) => a.action)).toContain('STUDENT_PHOTO_REPLACED');

    // Teachers may look, not change
    const byTeacher = await api.put(`/api/v1/students/${student.id}/photo`).set(bearer(teacher.token)).attach('photo', photo, 'p.jpg');
    expect(byTeacher.status).toBe(403);
  });

  it('replaces the birth certificate scan', async () => {
    const student = (await create(newStudent())).body.data;
    const res = await api
      .put(`/api/v1/students/${student.id}/birth-certificate-scan`)
      .set(bearer(registrar.token))
      .attach('birthCertificateScan', await image(1000, 700, 'png'), 'scan.png');
    expect(res.status).toBe(200);
    expect(res.body.data.birthCertificateScan.contentType).toBe('image/png');
    const file = await api.get(res.body.data.birthCertificateScan.url).set(bearer(teacher.token));
    expect(file.headers['content-disposition']).toBe(`inline; filename="${student.studentIdentifier}-birth-certificate.png"`);
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
    const res = await api
      .patch(`/api/v1/students/${student.id}`)
      .set(bearer(registrar.token))
      .send({ primarySchoolOrigin: 'Wat Phnom Primary', addressVillageCode: VILLAGES.tboung, addressHouseNo: null });
    expect(res.status).toBe(200);
    expect(res.body.data.primarySchoolOrigin).toBe('Wat Phnom Primary');
    expect(res.body.data.address.khmer).toBe('ភូមិត្បូង ឃុំព្រែក ស្រុកទីមួយ ខេត្តសាកល្បង');

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
    expect((await api.get(student.photo.url).set(bearer(principal.token))).status).toBe(404);
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
