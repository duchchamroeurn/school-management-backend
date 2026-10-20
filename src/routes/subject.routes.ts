import { Router } from 'express';
import { PERMISSIONS } from '../constants/permissions';
import * as subjectController from '../controllers/subject.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/requirePermission';

const router = Router();
const { SUBJECT } = PERMISSIONS;

router.use(authenticate());

router.get('/', requirePermission(SUBJECT.LIST), subjectController.list);
router.get('/:id', requirePermission(SUBJECT.VIEW), subjectController.get);
router.post('/', requirePermission(SUBJECT.CREATE), subjectController.create);
router.patch('/:id', requirePermission(SUBJECT.UPDATE), subjectController.update);
router.delete('/:id', requirePermission(SUBJECT.DELETE), subjectController.remove);

// Grade assignment changes the subject's curriculum, so it needs UPDATE_SUBJECT
router.post('/:id/grades', requirePermission(SUBJECT.UPDATE), subjectController.assignToGrades);
router.delete('/:id/grades/:gradeId', requirePermission(SUBJECT.UPDATE), subjectController.unassignFromGrade);

export default router;
