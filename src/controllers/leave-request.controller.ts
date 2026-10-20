import { Request, Response } from 'express';
import { LeaveRequestStatus } from '../generated/prisma/client';
import * as leaveRequestService from '../services/leave-request.service';
import { bodyOf, nullableString, optionalDate, optionalEnum, optionalString, pagination, queryString, required } from '../utils/validate';

const STATUSES = Object.values(LeaveRequestStatus);
const queryDate = (value: unknown, field: string) => optionalDate(queryString(value, field), field);

// GET /api/v1/leave-requests?studentId=&status=&from=&to=&page=&pageSize=  (from/to: leave overlapping that range)
export async function list(req: Request, res: Response) {
  const { page, pageSize, skip, take } = pagination(req.query);
  const { items, total } = await leaveRequestService.listLeaveRequests({
    studentId: queryString(req.query.studentId, 'studentId'),
    status: optionalEnum(queryString(req.query.status, 'status'), 'status', STATUSES),
    from: queryDate(req.query.from, 'from'),
    to: queryDate(req.query.to, 'to'),
    skip,
    take,
  });
  res.json({ status: 'success', data: items, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
}

// GET /api/v1/leave-requests/:id
export async function get(req: Request<{ id: string }>, res: Response) {
  res.json({ status: 'success', data: await leaveRequestService.getLeaveRequest(req.params.id) });
}

// POST /api/v1/leave-requests  { studentId, startDate, endDate, reason? } — created as PENDING
export async function create(req: Request, res: Response) {
  const body = bodyOf(req);
  const leave = await leaveRequestService.createLeaveRequest({
    studentId: required(optionalString(body.studentId, 'studentId'), 'studentId'),
    startDate: required(optionalDate(body.startDate, 'startDate'), 'startDate'),
    endDate: required(optionalDate(body.endDate, 'endDate'), 'endDate'),
    reason: nullableString(body.reason, 'reason'),
  });
  res.status(201).json({ status: 'success', data: leave });
}

// POST /api/v1/leave-requests/:id/approve — also excuses absences already recorded in the range
export async function approve(req: Request<{ id: string }>, res: Response) {
  res.json({ status: 'success', data: await leaveRequestService.approveLeaveRequest(req.params.id) });
}

// POST /api/v1/leave-requests/:id/reject
export async function reject(req: Request<{ id: string }>, res: Response) {
  res.json({ status: 'success', data: await leaveRequestService.rejectLeaveRequest(req.params.id) });
}

// POST /api/v1/leave-requests/:id/cancel — an approved leave's excused absences become unexcused again
export async function cancel(req: Request<{ id: string }>, res: Response) {
  res.json({ status: 'success', data: await leaveRequestService.cancelLeaveRequest(req.params.id) });
}
