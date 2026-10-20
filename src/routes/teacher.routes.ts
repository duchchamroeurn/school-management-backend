import { Router } from 'express';
import { PERMISSIONS } from '../constants/permissions';
import * as teacherAssignmentController from '../controllers/teacher-assignment.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/requirePermission';

const router = Router();

router.use(authenticate());

// The teacher's own data scope: the classes and subjects they may enter scores for
router.get('/my-classes', requirePermission(PERMISSIONS.SCORE.ENTER), teacherAssignmentController.myClasses);

export default router;
