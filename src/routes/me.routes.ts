import { Router } from 'express';
import { PERMISSIONS } from '../constants/permissions';
import * as meController from '../controllers/me.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/requirePermission';

const router = Router();
const { SELF_SERVICE } = PERMISSIONS;

router.use(authenticate());

router.get('/profile', requirePermission(SELF_SERVICE.VIEW_OWN_PROFILE), meController.profile);
router.get('/homeroom', requirePermission(SELF_SERVICE.VIEW_OWN_HOMEROOM), meController.homeroom);

export default router;
