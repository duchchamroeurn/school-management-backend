import { Request, Response } from 'express';
import { Errors } from '../constants/errors';
import * as locationService from '../services/location.service';
import { optionalInt, queryString, required } from '../utils/validate';

// Gazetteer codes: province 2 digits, district 4, commune 6, village 8
const CODE_LENGTH = { province: 2, district: 4, commune: 6, village: 8 } as const;

function code(value: string, level: keyof typeof CODE_LENGTH) {
  const length = CODE_LENGTH[level];
  if (!new RegExp(`^\\d{${length}}$`).test(value)) throw Errors.INVALID_FIELD('code', `must be a ${length}-digit ${level} code`);
  return value;
}

// GET /api/v1/locations/provinces
export async function provinces(_req: Request, res: Response) {
  res.json({ status: 'success', data: await locationService.listProvinces() });
}

// GET /api/v1/locations/provinces/:code/districts
export async function districts(req: Request<{ code: string }>, res: Response) {
  res.json({ status: 'success', data: await locationService.listDistricts(code(req.params.code, 'province')) });
}

// GET /api/v1/locations/districts/:code/communes
export async function communes(req: Request<{ code: string }>, res: Response) {
  res.json({ status: 'success', data: await locationService.listCommunes(code(req.params.code, 'district')) });
}

// GET /api/v1/locations/communes/:code/villages
export async function villages(req: Request<{ code: string }>, res: Response) {
  res.json({ status: 'success', data: await locationService.listVillages(code(req.params.code, 'commune')) });
}

// GET /api/v1/locations/villages?search=&limit= — villages by Khmer or Latin name (at least 2 characters), with full address
export async function searchVillages(req: Request, res: Response) {
  const search = required(queryString(req.query.search, 'search'), 'search');
  if (search.length < 2) throw Errors.INVALID_FIELD('search', 'must be at least 2 characters');
  const raw = queryString(req.query.limit, 'limit');
  const limit = raw === undefined ? 20 : optionalInt(Number(raw), 'limit', 1, 50)!;
  res.json({ status: 'success', data: await locationService.searchVillages(search, limit) });
}

// GET /api/v1/locations/villages/:code — the village with its commune, district, province and formatted address
export async function village(req: Request<{ code: string }>, res: Response) {
  res.json({ status: 'success', data: await locationService.getVillage(code(req.params.code, 'village')) });
}
