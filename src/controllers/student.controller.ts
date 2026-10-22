import { Request, Response } from 'express';
import { Errors } from '../constants/errors';
import { Gender, StudentStatus } from '../generated/prisma/client';
import { uploadedFile } from '../middlewares/upload';
import * as studentService from '../services/student.service';
import { StudentFileKind } from '../services/student.service';
import {
  bodyOf,
  nullableString,
  optionalDate,
  optionalDocumentNumber,
  optionalEnum,
  optionalFlag,
  optionalKhmerName,
  optionalLatinName,
  optionalVillageCode,
  pagination,
  queryString,
  required,
} from '../utils/validate';

const GENDERS = Object.values(Gender);
const STATUSES = Object.values(StudentStatus);

// Place of birth and current address: gazetteer village codes, plus optional house number and street
function addressFields(body: Record<string, unknown>) {
  return {
    birthPlaceVillageCode: optionalVillageCode(body.birthPlaceVillageCode, 'birthPlaceVillageCode'),
    addressVillageCode: optionalVillageCode(body.addressVillageCode, 'addressVillageCode'),
    addressHouseNo: nullableString(body.addressHouseNo, 'addressHouseNo', 20),
    addressStreet: nullableString(body.addressStreet, 'addressStreet', 100),
  };
}

// Father and mother as the registry records them; all optional (e.g. an unknown father)
function parentFields(body: Record<string, unknown>) {
  return {
    fatherName: nullableString(body.fatherName, 'fatherName'),
    fatherOccupation: nullableString(body.fatherOccupation, 'fatherOccupation'),
    isFatherDeceased: optionalFlag(body.isFatherDeceased, 'isFatherDeceased'),
    motherName: nullableString(body.motherName, 'motherName'),
    motherOccupation: nullableString(body.motherOccupation, 'motherOccupation'),
    isMotherDeceased: optionalFlag(body.isMotherDeceased, 'isMotherDeceased'),
  };
}

const requiredFile = (req: Request, field: StudentFileKind) => {
  const file = uploadedFile(req, field);
  if (!file) throw Errors.FILE_REQUIRED(field);
  return file;
};

// GET /api/v1/students?search=&status=&gender=&page=&pageSize=
export async function list(req: Request, res: Response) {
  const { page, pageSize, skip, take } = pagination(req.query);
  const { items, total } = await studentService.listStudents({
    search: queryString(req.query.search, 'search'),
    status: optionalEnum(queryString(req.query.status, 'status'), 'status', STATUSES),
    gender: optionalEnum(queryString(req.query.gender, 'gender'), 'gender', GENDERS),
    skip,
    take,
  });
  res.json({ status: 'success', data: items, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
}

// GET /api/v1/students/:id
export async function get(req: Request<{ id: string }>, res: Response) {
  res.json({ status: 'success', data: await studentService.getStudent(req.params.id) });
}

// POST /api/v1/students — multipart/form-data: the fields below as text, plus the files photo (4x4, JPEG/PNG)
// and birthCertificateScan (JPEG/PNG/PDF). Optional: primarySchoolOrigin, addressHouseNo, addressStreet and the
// parent fields (fatherName, fatherOccupation, isFatherDeceased, motherName, motherOccupation, isMotherDeceased).
export async function create(req: Request, res: Response) {
  const body = bodyOf(req);
  const address = addressFields(body);
  const student = await studentService.createStudent({
    birthCertificateNo: required(optionalDocumentNumber(body.birthCertificateNo, 'birthCertificateNo'), 'birthCertificateNo'),
    khmerName: required(optionalKhmerName(body.khmerName), 'khmerName'),
    latinName: required(optionalLatinName(body.latinName), 'latinName'),
    dateOfBirth: required(optionalDate(body.dateOfBirth, 'dateOfBirth'), 'dateOfBirth'),
    gender: required(optionalEnum(body.gender, 'gender', GENDERS), 'gender'),
    primarySchoolOrigin: nullableString(body.primarySchoolOrigin, 'primarySchoolOrigin'),
    ...parentFields(body),
    ...address,
    birthPlaceVillageCode: required(address.birthPlaceVillageCode, 'birthPlaceVillageCode'),
    addressVillageCode: required(address.addressVillageCode, 'addressVillageCode'),
    photo: requiredFile(req, 'photo'),
    birthCertificateScan: requiredFile(req, 'birthCertificateScan'),
  });
  res.status(201).json({ status: 'success', data: student });
}

// PATCH /api/v1/students/:id — JSON; studentIdentifier cannot be changed. The documents are replaced with
// PUT /students/:id/photo and PUT /students/:id/birth-certificate-scan.
export async function update(req: Request<{ id: string }>, res: Response) {
  const body = bodyOf(req);
  const student = await studentService.updateStudent(req.params.id, {
    birthCertificateNo: optionalDocumentNumber(body.birthCertificateNo, 'birthCertificateNo'),
    khmerName: optionalKhmerName(body.khmerName),
    latinName: optionalLatinName(body.latinName),
    dateOfBirth: optionalDate(body.dateOfBirth, 'dateOfBirth'),
    gender: optionalEnum(body.gender, 'gender', GENDERS),
    primarySchoolOrigin: nullableString(body.primarySchoolOrigin, 'primarySchoolOrigin'),
    status: optionalEnum(body.status, 'status', STATUSES),
    ...parentFields(body),
    ...addressFields(body),
  });
  res.json({ status: 'success', data: student });
}

// DELETE /api/v1/students/:id — mistaken records only; use status DROPPED_OUT otherwise
export async function remove(req: Request<{ id: string }>, res: Response) {
  await studentService.deleteStudent(req.params.id);
  res.status(204).end();
}

// PUT /api/v1/students/:id/photo — multipart/form-data with the file in "photo"
export async function replacePhoto(req: Request<{ id: string }>, res: Response) {
  res.json({ status: 'success', data: await studentService.replaceStudentFile(req.params.id, 'photo', requiredFile(req, 'photo')) });
}

// PUT /api/v1/students/:id/birth-certificate-scan — multipart/form-data with the file in "birthCertificateScan"
export async function replaceBirthCertificateScan(req: Request<{ id: string }>, res: Response) {
  const file = requiredFile(req, 'birthCertificateScan');
  res.json({ status: 'success', data: await studentService.replaceStudentFile(req.params.id, 'birthCertificateScan', file) });
}

// GET /api/v1/students/:id/photo and /birth-certificate-scan — the file itself. Personal data: never cached
// by shared caches; the browser revalidates with the ETag (the file's SHA-256), so an unchanged file isn't re-sent.
const download = (kind: StudentFileKind) => async (req: Request<{ id: string }>, res: Response) => {
  const file = await studentService.getStudentFile(req.params.id, kind);
  res.set({ 'Cache-Control': 'private, no-cache', ETag: file.etag });
  if (req.fresh) {
    res.status(304).end();
    return;
  }
  const body = await file.open();
  res.set({
    'Content-Type': file.contentType,
    'Content-Length': String(file.size),
    'Content-Disposition': `inline; filename="${file.filename}"`,
  });
  body.on('error', () => res.destroy());
  body.pipe(res);
};

export const photo = download('photo');
export const birthCertificateScan = download('birthCertificateScan');
