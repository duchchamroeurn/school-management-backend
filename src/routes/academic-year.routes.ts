import { Router } from 'express';
import { PERMISSIONS } from '../constants/permissions';
import * as academicYearController from '../controllers/academic-year.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/requirePermission';

const router = Router();
const { ACADEMIC_YEAR } = PERMISSIONS;

router.use(authenticate());

router.get('/', requirePermission(ACADEMIC_YEAR.LIST), academicYearController.list);
router.get('/:id', requirePermission(ACADEMIC_YEAR.VIEW), academicYearController.get);
router.post('/', requirePermission(ACADEMIC_YEAR.CREATE), academicYearController.create);
router.patch('/:id', requirePermission(ACADEMIC_YEAR.UPDATE), academicYearController.update);
router.delete('/:id', requirePermission(ACADEMIC_YEAR.DELETE), academicYearController.remove);

export default router;
