import { Router } from 'express';
import { PERMISSIONS } from '../constants/permissions';
import * as classSectionController from '../controllers/class-section.controller';
import * as enrollmentController from '../controllers/enrollment.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/requirePermission';

const router = Router();
const { CLASS_SECTION, ENROLLMENT, STUDENT } = PERMISSIONS;

router.use(authenticate());

router.get('/', requirePermission(CLASS_SECTION.LIST), classSectionController.list);
router.get('/:id', requirePermission(CLASS_SECTION.VIEW), classSectionController.get);
router.get('/:id/roster', requirePermission(CLASS_SECTION.VIEW, ENROLLMENT.LIST), enrollmentController.roster);
// End-of-year promotion: creates next-year enrollments and, in the top grade, marks students GRADUATED
router.post('/:id/promote', requirePermission(ENROLLMENT.CREATE, STUDENT.UPDATE), enrollmentController.promote);
router.post('/', requirePermission(CLASS_SECTION.CREATE), classSectionController.create);
router.patch('/:id', requirePermission(CLASS_SECTION.UPDATE), classSectionController.update);
router.delete('/:id', requirePermission(CLASS_SECTION.DELETE), classSectionController.remove);

export default router;
