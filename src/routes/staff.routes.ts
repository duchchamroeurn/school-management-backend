import { Router } from 'express';
import { PERMISSIONS } from '../constants/permissions';
import * as staffController from '../controllers/staff.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/requirePermission';

const router = Router();
const { STAFF, CLASS_SECTION } = PERMISSIONS;

router.use(authenticate());

// Registered before /:id so "assign-homeroom" isn't treated as an id
router.post('/assign-homeroom', requirePermission(CLASS_SECTION.UPDATE), staffController.assignHomeroom);

router.get('/', requirePermission(STAFF.LIST), staffController.list);
router.get('/:id', requirePermission(STAFF.VIEW), staffController.get);
router.post('/', requirePermission(STAFF.CREATE), staffController.create);
router.patch('/:id', requirePermission(STAFF.UPDATE), staffController.update);
router.delete('/:id', requirePermission(STAFF.DELETE), staffController.remove);

export default router;
