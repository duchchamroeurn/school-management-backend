import { Router } from 'express';
import { PERMISSIONS } from '../constants/permissions';
import * as timetableController from '../controllers/timetable.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/requirePermission';

const router = Router();
const { CLASS_SECTION, TIMETABLE } = PERMISSIONS;

router.use(authenticate());

router.get('/', requirePermission(CLASS_SECTION.LIST), timetableController.listRooms);
router.post('/', requirePermission(TIMETABLE.MANAGE), timetableController.createRoom);
router.patch('/:id', requirePermission(TIMETABLE.MANAGE), timetableController.updateRoom);
router.delete('/:id', requirePermission(TIMETABLE.MANAGE), timetableController.deleteRoom);

export default router;
