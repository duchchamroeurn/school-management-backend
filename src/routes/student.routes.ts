import { Router } from 'express';
import { PERMISSIONS } from '../constants/permissions';
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

export default router;
