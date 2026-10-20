import { Router } from 'express';
import { PERMISSIONS } from '../constants/permissions';
import * as attendanceController from '../controllers/attendance.controller';
import * as leaveRequestController from '../controllers/leave-request.controller';
import { authenticate } from '../middlewares/authenticate';
import { requireAnyPermission, requirePermission } from '../middlewares/requirePermission';

const { ATTENDANCE, LEAVE_REQUEST } = PERMISSIONS;

// MARK / VIEW are scoped to the user's own classes by the service; the *_ANY permissions lift that scope
export const attendanceRoutes = Router();
attendanceRoutes.use(authenticate());

attendanceRoutes.post('/', requireAnyPermission(ATTENDANCE.MARK, ATTENDANCE.MARK_ANY), attendanceController.mark);
attendanceRoutes.get('/class-sections/:id', requireAnyPermission(ATTENDANCE.VIEW, ATTENDANCE.VIEW_ANY), attendanceController.classSheet);
attendanceRoutes.get('/students/:id', requirePermission(ATTENDANCE.VIEW_ANY), attendanceController.studentHistory);

export const leaveRequestRoutes = Router();
leaveRequestRoutes.use(authenticate());

leaveRequestRoutes.get('/', requirePermission(LEAVE_REQUEST.LIST), leaveRequestController.list);
leaveRequestRoutes.get('/:id', requirePermission(LEAVE_REQUEST.LIST), leaveRequestController.get);
leaveRequestRoutes.post('/', requirePermission(LEAVE_REQUEST.CREATE), leaveRequestController.create);
leaveRequestRoutes.post('/:id/approve', requirePermission(LEAVE_REQUEST.REVIEW), leaveRequestController.approve);
leaveRequestRoutes.post('/:id/reject', requirePermission(LEAVE_REQUEST.REVIEW), leaveRequestController.reject);
leaveRequestRoutes.post('/:id/cancel', requirePermission(LEAVE_REQUEST.REVIEW), leaveRequestController.cancel);
