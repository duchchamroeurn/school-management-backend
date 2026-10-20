import { Request, Response } from 'express';
import * as dashboardService from '../services/dashboard.service';
import { queryString } from '../utils/validate';

// GET /api/v1/dashboard?academicYearId= — the sections the signed-in user's permissions allow (ACTIVE year by default)
export async function get(req: Request, res: Response) {
  const viewer = { userId: req.user!.id, permissions: req.user!.permissions, staffProfileId: req.user!.staffProfileId };
  res.json({ status: 'success', data: await dashboardService.getDashboard(viewer, queryString(req.query.academicYearId, 'academicYearId')) });
}
