import { Request, Response } from 'express';
import * as meService from '../services/me.service';
import { queryString } from '../utils/validate';

// GET /api/v1/me/profile
export async function profile(req: Request, res: Response) {
  res.json({ status: 'success', data: await meService.getOwnProfile(req.user!.id) });
}

// GET /api/v1/me/homeroom?academicYear=2026-2027 (defaults to the ACTIVE year)
export async function homeroom(req: Request, res: Response) {
  const academicYear = queryString(req.query.academicYear, 'academicYear');
  res.json({ status: 'success', data: await meService.getOwnHomeroom(req.user!.id, academicYear) });
}
