import { Router } from 'express';
import { PERMISSIONS } from '../constants/permissions';
import * as gradingController from '../controllers/grading.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/requirePermission';

const router = Router();

router.use(authenticate());

router.post('/subject', requirePermission(PERMISSIONS.SCORE.ENTER), gradingController.recordSubjectScore);

export default router;
