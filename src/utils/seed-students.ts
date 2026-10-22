// Imports students from a JSON file (default: data/students.json) using the same validation and
// service as POST /api/v1/students. Kept separate from the main seed because the file holds real
// personal data (data/ is git-ignored and not part of the Docker image).
//
//   npm run db:seed:students                 # validate + import
//   npm run db:seed:students -- --dry-run    # validate only
//   npm run db:seed:students -- path/to/file.json
//
// Entry: { birthCertificateNo, khmerName, latinName, dateOfBirth, gender, primarySchoolOrigin?,
//          fatherName?, fatherOccupation?, isFatherDeceased?, motherName?, motherOccupation?, isMotherDeceased?,
//          birthPlaceVillageCode, addressVillageCode, addressHouseNo?, addressStreet?,
//          photo, birthCertificateScan }
//   *VillageCode         — 8-digit gazetteer codes (import the gazetteer first: npm run db:seed:gazetteer)
//   photo                — path of the 4x4 photo (JPEG/PNG), relative to the JSON file, e.g. "photos/1001-2013.jpg"
//   birthCertificateScan — path of the scan (JPEG/PNG/PDF), relative to the JSON file
//
// --demo-placeholders (demo installs only, refused with NODE_ENV=production): entries without documents get
// generated placeholder ones, and entries without village codes get villages picked from the gazetteer.
//
// Students whose birth certificate is already registered are skipped, so it can be re-run safely.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Gender } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { Upload } from '../services/file.service';
import { createStudent, CreateStudentInput } from '../services/student.service';
import { demoBirthCertificate, demoPhoto } from './demo-documents';
import { runImport } from './import-runner';
import {
  nullableString,
  optionalDate,
  optionalDocumentNumber,
  optionalBoolean,
  optionalEnum,
  optionalKhmerName,
  optionalLatinName,
  optionalString,
  optionalVillageCode,
  required,
} from './validate';

type ImportedStudent = Omit<CreateStudentInput, 'photo' | 'birthCertificateScan'> & { photo?: Upload; birthCertificateScan?: Upload };

const args = process.argv.slice(2);
const placeholders = args.includes('--demo-placeholders');
// Same file runImport reads; document paths are relative to its folder
const baseDir = dirname(resolve(args.find((a) => !a.startsWith('--')) ?? 'data/students.json'));

/** A stable pick for the student, so re-runs give the same demo villages */
const pickFor = <T>(items: T[], key: string) => items[createHash('sha256').update(key).digest().readUInt32BE(0) % items.length];

function readDocument(value: unknown, field: string): Upload | undefined {
  const path = optionalString(value, field, 500);
  if (path === undefined) {
    if (placeholders) return undefined;
    throw new Error(`${field} is required: the path of the file, relative to the JSON file`);
  }
  const full = resolve(baseDir, path);
  if (!existsSync(full)) throw new Error(`${field} file not found: ${full}`);
  return { buffer: readFileSync(full), originalName: path };
}

async function main() {
  if (placeholders && process.env.NODE_ENV === 'production') throw new Error('--demo-placeholders is for demo data and refused with NODE_ENV=production');

  const villageCodes = (await prisma.village.findMany({ select: { code: true }, orderBy: { code: 'asc' } })).map((v) => v.code);
  if (!villageCodes.length) throw new Error('The gazetteer is empty. Import it first: npm run gazetteer:download && npm run db:seed:gazetteer');
  const knownVillages = new Set(villageCodes);

  const village = (value: unknown, field: string, demoKey: string) => {
    const code = optionalVillageCode(value, field) ?? (placeholders ? pickFor(villageCodes, `${field} ${demoKey}`) : undefined);
    if (!knownVillages.has(required(code, field))) throw new Error(`${field}: no village with code ${code} in the gazetteer`);
    return code!;
  };

  await runImport<ImportedStudent, Awaited<ReturnType<typeof createStudent>>>({
    label: 'student',
    defaultFile: 'data/students.json',
    keyName: 'birthCertificateNo',
    toInput: (raw) => {
      const birthCertificateNo = required(optionalDocumentNumber(raw.birthCertificateNo, 'birthCertificateNo'), 'birthCertificateNo');
      return {
        birthCertificateNo,
        khmerName: required(optionalKhmerName(raw.khmerName), 'khmerName'),
        latinName: required(optionalLatinName(raw.latinName), 'latinName'),
        dateOfBirth: required(optionalDate(raw.dateOfBirth, 'dateOfBirth'), 'dateOfBirth'),
        gender: required(optionalEnum(raw.gender, 'gender', Object.values(Gender)), 'gender'),
        primarySchoolOrigin: nullableString(raw.primarySchoolOrigin, 'primarySchoolOrigin'),
        fatherName: nullableString(raw.fatherName, 'fatherName'),
        fatherOccupation: nullableString(raw.fatherOccupation, 'fatherOccupation'),
        isFatherDeceased: optionalBoolean(raw.isFatherDeceased, 'isFatherDeceased'),
        motherName: nullableString(raw.motherName, 'motherName'),
        motherOccupation: nullableString(raw.motherOccupation, 'motherOccupation'),
        isMotherDeceased: optionalBoolean(raw.isMotherDeceased, 'isMotherDeceased'),
        birthPlaceVillageCode: village(raw.birthPlaceVillageCode, 'birthPlaceVillageCode', birthCertificateNo),
        addressVillageCode: village(raw.addressVillageCode, 'addressVillageCode', birthCertificateNo),
        addressHouseNo: nullableString(raw.addressHouseNo, 'addressHouseNo', 20),
        addressStreet: nullableString(raw.addressStreet, 'addressStreet', 100),
        photo: readDocument(raw.photo, 'photo'),
        birthCertificateScan: readDocument(raw.birthCertificateScan, 'birthCertificateScan'),
      };
    },
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
    create: async (input) =>
      createStudent({
        ...input,
        photo: input.photo ?? (await demoPhoto(input)),
        birthCertificateScan: input.birthCertificateScan ?? (await demoBirthCertificate(input)),
      }),
    describe: (s) => `${s.studentIdentifier}  ${s.khmerName} / ${s.latinName}  —  ${s.address.khmer}`,
  });
}

main().catch(async (err) => {
  console.error(`✘ ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
  await prisma.$disconnect();
});
