import { Request, Response } from 'express';
import { Gender, StudentStatus } from '../generated/prisma/client';
import * as studentService from '../services/student.service';
import {
  bodyOf,
  nullableString,
  optionalDate,
  optionalDocumentNumber,
  optionalEnum,
  optionalKhmerName,
  optionalLatinName,
  pagination,
  queryString,
  required,
} from '../utils/validate';

const GENDERS = Object.values(Gender);
const STATUSES = Object.values(StudentStatus);

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

// POST /api/v1/students
export async function create(req: Request, res: Response) {
  const body = bodyOf(req);
  const student = await studentService.createStudent({
    birthCertificateNo: required(optionalDocumentNumber(body.birthCertificateNo, 'birthCertificateNo'), 'birthCertificateNo'),
    khmerName: required(optionalKhmerName(body.khmerName), 'khmerName'),
    latinName: required(optionalLatinName(body.latinName), 'latinName'),
    dateOfBirth: required(optionalDate(body.dateOfBirth, 'dateOfBirth'), 'dateOfBirth'),
    gender: required(optionalEnum(body.gender, 'gender', GENDERS), 'gender'),
    primarySchoolOrigin: nullableString(body.primarySchoolOrigin, 'primarySchoolOrigin'),
  });
  res.status(201).json({ status: 'success', data: student });
}

// PATCH /api/v1/students/:id — studentIdentifier cannot be changed
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
  });
  res.json({ status: 'success', data: student });
}

// DELETE /api/v1/students/:id — mistaken records only; use status DROPPED_OUT otherwise
export async function remove(req: Request<{ id: string }>, res: Response) {
  await studentService.deleteStudent(req.params.id);
  res.status(204).end();
}
