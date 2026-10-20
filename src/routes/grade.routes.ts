import { Router } from 'express';
import { PERMISSIONS } from '../constants/permissions';
import * as gradeController from '../controllers/grade.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/requirePermission';

const router = Router();
const { GRADE } = PERMISSIONS;

router.use(authenticate());

router.get('/', requirePermission(GRADE.LIST), gradeController.list);
router.get('/:id', requirePermission(GRADE.VIEW), gradeController.get);
router.post('/', requirePermission(GRADE.CREATE), gradeController.create);
router.patch('/:id', requirePermission(GRADE.UPDATE), gradeController.update);
router.delete('/:id', requirePermission(GRADE.DELETE), gradeController.remove);

export default router;
