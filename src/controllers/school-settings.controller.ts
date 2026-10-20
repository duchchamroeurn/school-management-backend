import { Request, Response } from 'express';
import { SchoolLevel } from '../generated/prisma/client';
import * as schoolSettingsService from '../services/school-settings.service';
import { HttpError } from '../utils/httpError';
import { bodyOf, nullablePhone, nullableString, optionalEnum } from '../utils/validate';

// Khmer script (incl. Khmer digits), spaces and common punctuation
const nullableKhmerText = (value: unknown, field: string) => {
  const text = nullableString(value, field);
  if (text && !/^[ក-៿᧠-᧿\s.,()\-]+$/.test(text)) {
    throw new HttpError(400, 'VALIDATION_ERROR', `${field} must be written in Khmer script`, { field });
  }
  return text;
};

// GET /api/v1/school-settings — any signed-in user (every screen needs the school name)
export async function get(_req: Request, res: Response) {
  res.json({ status: 'success', data: await schoolSettingsService.getSchoolSettings() });
}

// PATCH /api/v1/school-settings — UPDATE_SCHOOL_SETTINGS
export async function update(req: Request, res: Response) {
  const body = bodyOf(req);
  const result = await schoolSettingsService.updateSchoolSettings({
    level: optionalEnum(body.level, 'level', Object.values(SchoolLevel)),
    khmerName: nullableKhmerText(body.khmerName, 'khmerName'),
    latinName: nullableString(body.latinName, 'latinName'),
    moeysCode: nullableString(body.moeysCode, 'moeysCode'),
    address: nullableString(body.address, 'address'),
    phone: nullablePhone(body.phone),
  });
  res.json({ status: 'success', data: result });
}
