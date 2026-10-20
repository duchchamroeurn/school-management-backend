import { Router } from 'express';
import { PERMISSIONS } from '../constants/permissions';
import * as teacherAssignmentController from '../controllers/teacher-assignment.controller';
import { authenticate } from '../middlewares/authenticate';
import { requireAnyPermission } from '../middlewares/requirePermission';

const router = Router();

router.use(authenticate());
// Academic Coordinator work: staffing classes is part of managing either classes or staff
router.use(requireAnyPermission(PERMISSIONS.CLASS_SECTION.UPDATE, PERMISSIONS.STAFF.UPDATE));

router.get('/class/:classSectionId', teacherAssignmentController.classOverview);

router.get('/subject-teacher', teacherAssignmentController.list);
router.get('/subject-teacher/:id', teacherAssignmentController.get);
router.post('/subject-teacher', teacherAssignmentController.create);
router.patch('/subject-teacher/:id', teacherAssignmentController.update);
router.delete('/subject-teacher/:id', teacherAssignmentController.remove);

export default router;
