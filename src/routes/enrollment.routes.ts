import { Router } from 'express';
import { PERMISSIONS } from '../constants/permissions';
import * as enrollmentController from '../controllers/enrollment.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/requirePermission';

const router = Router();
const { ENROLLMENT } = PERMISSIONS;

router.use(authenticate());

router.get('/', requirePermission(ENROLLMENT.LIST), enrollmentController.list);
router.get('/:id', requirePermission(ENROLLMENT.VIEW), enrollmentController.get);
router.post('/', requirePermission(ENROLLMENT.CREATE), enrollmentController.create);
router.patch('/:id', requirePermission(ENROLLMENT.UPDATE), enrollmentController.update);
router.delete('/:id', requirePermission(ENROLLMENT.DELETE), enrollmentController.remove);

export default router;
