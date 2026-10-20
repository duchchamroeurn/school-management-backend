import { Router } from 'express';
import { PERMISSIONS } from '../constants/permissions';
import * as timetableController from '../controllers/timetable.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/requirePermission';

const router = Router();
const { CLASS_SECTION, TIMETABLE } = PERMISSIONS;
const canRead = requirePermission(CLASS_SECTION.VIEW);
const canManage = requirePermission(TIMETABLE.MANAGE);

router.use(authenticate());

// Registered before the /:param routes
router.get('/me', timetableController.myTimetable);
router.get('/quotas', canRead, timetableController.quotaOverview);

router.get('/time-slots', canRead, timetableController.listTimeSlots);
router.post('/time-slots', canManage, timetableController.createTimeSlot);
router.patch('/time-slots/:id', canManage, timetableController.updateTimeSlot);
router.delete('/time-slots/:id', canManage, timetableController.deleteTimeSlot);

router.get('/classes/:classSectionId', canRead, timetableController.classTimetable);
router.put('/classes/:classSectionId/slots/:timeSlotId', canManage, timetableController.setLesson);
router.delete('/classes/:classSectionId/slots/:timeSlotId', canManage, timetableController.removeLesson);

router.get('/teachers/:staffId', canRead, timetableController.teacherTimetable);

export default router;
