import { Router } from 'express';
import { PERMISSIONS } from '../constants/permissions';
import * as auditLogController from '../controllers/audit-log.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/requirePermission';

const router = Router();

router.use(authenticate());

// Read-only on purpose: there is no route to change or delete audit entries
router.get('/', requirePermission(PERMISSIONS.AUDIT_LOG.LIST), auditLogController.list);

export default router;
