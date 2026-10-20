import { Router } from 'express';
import { PERMISSIONS } from '../constants/permissions';
import * as periodController from '../controllers/assessment-period.controller';
import { authenticate } from '../middlewares/authenticate';
import { requireAnyPermission, requirePermission } from '../middlewares/requirePermission';

const router = Router();
const { ASSESSMENT, SCORE, REPORT_CARD } = PERMISSIONS;

router.use(authenticate());

// Teachers need the periods and rules to enter scores; whoever prints report cards needs the periods
const canRead = requireAnyPermission(ASSESSMENT.MANAGE, SCORE.ENTER, SCORE.ENTER_ANY, REPORT_CARD.VIEW, REPORT_CARD.VIEW_ANY);
const canManage = requirePermission(ASSESSMENT.MANAGE);

router.get('/', canRead, periodController.list);
router.get('/:id', canRead, periodController.get);
router.post('/', canManage, periodController.create);
router.patch('/:id', canManage, periodController.update);
router.delete('/:id', canManage, periodController.remove);

router.post('/:id/lock', requirePermission(ASSESSMENT.LOCK), periodController.lock);
router.post('/:id/unlock', requirePermission(ASSESSMENT.LOCK), periodController.unlock);

router.put('/:id/subjects/:subjectId', canManage, periodController.setSubjectRules);
router.delete('/:id/subjects/:subjectId', canManage, periodController.removeSubjectRules);
router.post('/:id/copy-rules', canManage, periodController.copyRules);

export default router;
