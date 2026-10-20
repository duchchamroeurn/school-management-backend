import { Router } from 'express';
import { PERMISSIONS } from '../constants/permissions';
import * as guardianController from '../controllers/guardian.controller';
import * as studentController from '../controllers/student.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/requirePermission';

const router = Router();
const { STUDENT } = PERMISSIONS;

router.use(authenticate());

router.get('/', requirePermission(STUDENT.LIST), studentController.list);
router.get('/:id', requirePermission(STUDENT.VIEW), studentController.get);
router.post('/', requirePermission(STUDENT.CREATE), studentController.create);
router.patch('/:id', requirePermission(STUDENT.UPDATE), studentController.update);
router.delete('/:id', requirePermission(STUDENT.DELETE), studentController.remove);

// Guardians of a student
router.get('/:id/guardians', requirePermission(STUDENT.VIEW), guardianController.listForStudent);
router.post('/:id/guardians', requirePermission(STUDENT.UPDATE), guardianController.linkToStudent);
router.patch('/:id/guardians/:guardianId', requirePermission(STUDENT.UPDATE), guardianController.updateLink);
router.delete('/:id/guardians/:guardianId', requirePermission(STUDENT.UPDATE), guardianController.unlinkFromStudent);

export default router;
