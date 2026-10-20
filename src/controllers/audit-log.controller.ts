import { Request, Response } from 'express';
import { ALL_AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../constants/audit';
import * as auditService from '../services/audit.service';
import { optionalDate, optionalEnum, pagination, queryString } from '../utils/validate';

// GET /api/v1/audit-logs?entityType=&entityId=&action=&actorUserId=&from=&to=&page=&pageSize=
// from/to are dates (YYYY-MM-DD), both inclusive. Newest first.
export async function list(req: Request, res: Response) {
  const { page, pageSize, skip, take } = pagination(req.query);
  const to = optionalDate(queryString(req.query.to, 'to'), 'to');
  const { items, total } = await auditService.listAuditLogs({
    entityType: optionalEnum(queryString(req.query.entityType, 'entityType'), 'entityType', AUDIT_ENTITY_TYPES),
    entityId: queryString(req.query.entityId, 'entityId'),
    action: optionalEnum(queryString(req.query.action, 'action'), 'action', ALL_AUDIT_ACTIONS),
    actorUserId: queryString(req.query.actorUserId, 'actorUserId'),
    from: optionalDate(queryString(req.query.from, 'from'), 'from'),
    // Inclusive end date: everything before the start of the next day
    to: to && new Date(to.getTime() + 24 * 60 * 60 * 1000),
    skip,
    take,
  });
  res.json({ status: 'success', data: items, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
}
