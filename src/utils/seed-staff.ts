// Imports staff from a JSON file (default: data/staff.json) using the same validation and
// service as POST /api/v1/staff. Kept separate from the main seed because the file holds real
// personal data (data/ is git-ignored and not part of the Docker image).
//
//   npm run db:seed:staff                 # validate + import
//   npm run db:seed:staff -- --dry-run    # validate only
//   npm run db:seed:staff -- path/to/file.json
//
// Staff whose national ID is already registered are skipped, so it can be re-run safely.
import { Gender } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { createStaff } from '../services/staff.service';
import { runImport } from './import-runner';
import {
  nullablePhone,
  nullableTelegramHandle,
  optionalDate,
  optionalDocumentNumber,
  optionalEnum,
  optionalKhmerName,
  optionalLatinName,
  required,
} from './validate';

runImport({
  label: 'staff member',
  defaultFile: 'data/staff.json',
  keyName: 'nationalIdNo',
  toInput: (raw) => ({
    nationalIdNo: required(optionalDocumentNumber(raw.nationalIdNo, 'nationalIdNo'), 'nationalIdNo'),
    khmerName: required(optionalKhmerName(raw.khmerName), 'khmerName'),
    latinName: required(optionalLatinName(raw.latinName), 'latinName'),
    gender: required(optionalEnum(raw.gender, 'gender', Object.values(Gender)), 'gender'),
    phone: nullablePhone(raw.phone),
    telegramHandle: nullableTelegramHandle(raw.telegramHandle),
    hireDate: required(optionalDate(raw.hireDate, 'hireDate'), 'hireDate'),
  }),
  keyOf: (input) => input.nationalIdNo,
  findExisting: async (keys) =>
    new Map(
      (
        await prisma.staffProfile.findMany({
          where: { nationalIdNo: { in: keys } },
          select: { nationalIdNo: true, latinName: true, khmerName: true },
        })
      ).map((s) => [s.nationalIdNo, `${s.latinName} (${s.khmerName})`]),
    ),
  create: createStaff,
  describe: (s) => `${s.nationalIdNo}  ${s.khmerName} / ${s.latinName}  ${s.phone ?? ''} ${s.telegramHandle ?? ''}`.trimEnd(),
});
