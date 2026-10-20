// Imports students from a JSON file (default: data/students.json) using the same validation and
// service as POST /api/v1/students. Kept separate from the main seed because the file holds real
// personal data (data/ is git-ignored and not part of the Docker image).
//
//   npm run db:seed:students                 # validate + import
//   npm run db:seed:students -- --dry-run    # validate only
//   npm run db:seed:students -- path/to/file.json
//
// Students whose birth certificate is already registered are skipped, so it can be re-run safely.
import { Gender } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { createStudent } from '../services/student.service';
import { runImport } from './import-runner';
import {
  nullableString,
  optionalDate,
  optionalDocumentNumber,
  optionalEnum,
  optionalKhmerName,
  optionalLatinName,
  required,
} from './validate';

runImport({
  label: 'student',
  defaultFile: 'data/students.json',
  keyName: 'birthCertificateNo',
  toInput: (raw) => ({
    birthCertificateNo: required(optionalDocumentNumber(raw.birthCertificateNo, 'birthCertificateNo'), 'birthCertificateNo'),
    khmerName: required(optionalKhmerName(raw.khmerName), 'khmerName'),
    latinName: required(optionalLatinName(raw.latinName), 'latinName'),
    dateOfBirth: required(optionalDate(raw.dateOfBirth, 'dateOfBirth'), 'dateOfBirth'),
    gender: required(optionalEnum(raw.gender, 'gender', Object.values(Gender)), 'gender'),
    primarySchoolOrigin: nullableString(raw.primarySchoolOrigin, 'primarySchoolOrigin'),
  }),
  keyOf: (input) => input.birthCertificateNo,
  findExisting: async (keys) =>
    new Map(
      (
        await prisma.studentProfile.findMany({
          where: { birthCertificateNo: { in: keys } },
          select: { birthCertificateNo: true, studentIdentifier: true },
        })
      ).map((s) => [s.birthCertificateNo, s.studentIdentifier]),
    ),
  create: createStudent,
  describe: (s) => `${s.studentIdentifier}  ${s.khmerName} / ${s.latinName}`,
});
