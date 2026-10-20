import { Router } from 'express';
import { PERMISSIONS } from '../constants/permissions';
import * as schoolSettingsController from '../controllers/school-settings.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/requirePermission';

const router = Router();

router.use(authenticate());

router.get('/', schoolSettingsController.get);
router.patch('/', requirePermission(PERMISSIONS.SCHOOL_SETTINGS.UPDATE), schoolSettingsController.update);

export default router;
