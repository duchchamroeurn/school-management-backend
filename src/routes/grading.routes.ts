import { Router } from 'express';
import { PERMISSIONS } from '../constants/permissions';
import * as gradingController from '../controllers/grading.controller';
import { authenticate } from '../middlewares/authenticate';
import { requireAnyPermission, requirePermission } from '../middlewares/requirePermission';

const router = Router();

router.use(authenticate());

router.post('/subject', requirePermission(PERMISSIONS.SCORE.ENTER), gradingController.recordSubjectScore);
// Reading a sheet: ENTER_SCORES (own subjects and classes, checked in the service) or ENTER_ANY_SCORES
router.get('/subject-sheet', requireAnyPermission(PERMISSIONS.SCORE.ENTER, PERMISSIONS.SCORE.ENTER_ANY), gradingController.subjectSheet);
// Homeroom class only unless CALCULATE_ANY_RESULTS (checked in the service)
router.post('/results/calculate', requireAnyPermission(PERMISSIONS.RESULT.CALCULATE, PERMISSIONS.RESULT.CALCULATE_ANY), gradingController.calculateResults);
router.patch('/results/remarks', requireAnyPermission(PERMISSIONS.RESULT.CALCULATE, PERMISSIONS.RESULT.CALCULATE_ANY), gradingController.updateRemarks);

export default router;
