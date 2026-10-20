import { Router } from 'express';
import { PERMISSIONS } from '../constants/permissions';
import * as teachingAssignmentController from '../controllers/teaching-assignment.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/requirePermission';

const router = Router();
const { TEACHING_ASSIGNMENT } = PERMISSIONS;

router.use(authenticate());

router.get('/', requirePermission(TEACHING_ASSIGNMENT.LIST), teachingAssignmentController.list);
router.get('/:id', requirePermission(TEACHING_ASSIGNMENT.VIEW), teachingAssignmentController.get);
router.post('/', requirePermission(TEACHING_ASSIGNMENT.CREATE), teachingAssignmentController.create);
router.patch('/:id', requirePermission(TEACHING_ASSIGNMENT.UPDATE), teachingAssignmentController.update);
router.delete('/:id', requirePermission(TEACHING_ASSIGNMENT.DELETE), teachingAssignmentController.remove);

export default router;
