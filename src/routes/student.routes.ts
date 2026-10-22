import { Router } from 'express';
import { PERMISSIONS } from '../constants/permissions';
import * as guardianController from '../controllers/guardian.controller';
import * as studentController from '../controllers/student.controller';
import { authenticate } from '../middlewares/authenticate';
import { acceptFiles } from '../middlewares/upload';
import { requirePermission } from '../middlewares/requirePermission';

const router = Router();
const { STUDENT } = PERMISSIONS;

router.use(authenticate());

router.get('/', requirePermission(STUDENT.LIST), studentController.list);
router.get('/:id', requirePermission(STUDENT.VIEW), studentController.get);
// multipart/form-data: the student's details + the 4x4 photo and the birth certificate scan
router.post('/', requirePermission(STUDENT.CREATE), acceptFiles('photo', 'birthCertificateScan'), studentController.create);
router.patch('/:id', requirePermission(STUDENT.UPDATE), studentController.update);
router.delete('/:id', requirePermission(STUDENT.DELETE), studentController.remove);

// Documents for the registry (សៀវភៅបញ្ជីឈ្មោះសិស្ស)
router.get('/:id/photo', requirePermission(STUDENT.VIEW), studentController.photo);
router.put('/:id/photo', requirePermission(STUDENT.UPDATE), acceptFiles('photo'), studentController.replacePhoto);
router.get('/:id/birth-certificate-scan', requirePermission(STUDENT.VIEW), studentController.birthCertificateScan);
router.put('/:id/birth-certificate-scan', requirePermission(STUDENT.UPDATE), acceptFiles('birthCertificateScan'), studentController.replaceBirthCertificateScan);

// Guardians of a student
router.get('/:id/guardians', requirePermission(STUDENT.VIEW), guardianController.listForStudent);
router.post('/:id/guardians', requirePermission(STUDENT.UPDATE), guardianController.linkToStudent);
router.patch('/:id/guardians/:guardianId', requirePermission(STUDENT.UPDATE), guardianController.updateLink);
router.delete('/:id/guardians/:guardianId', requirePermission(STUDENT.UPDATE), guardianController.unlinkFromStudent);

export default router;
