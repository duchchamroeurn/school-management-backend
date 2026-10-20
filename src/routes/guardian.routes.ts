import { Router } from 'express';
import { PERMISSIONS } from '../constants/permissions';
import * as guardianController from '../controllers/guardian.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/requirePermission';

const router = Router();
const { STUDENT } = PERMISSIONS;

router.use(authenticate());

// Guardian contacts are part of the student record: seen with VIEW_STUDENT, managed with UPDATE_STUDENT
router.get('/', requirePermission(STUDENT.LIST), guardianController.list);
router.get('/:id', requirePermission(STUDENT.VIEW), guardianController.get);
router.post('/', requirePermission(STUDENT.UPDATE), guardianController.create);
router.patch('/:id', requirePermission(STUDENT.UPDATE), guardianController.update);
router.delete('/:id', requirePermission(STUDENT.UPDATE), guardianController.remove);

export default router;
