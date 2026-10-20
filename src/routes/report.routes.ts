import { Router } from 'express';
import { PERMISSIONS } from '../constants/permissions';
import * as reportController from '../controllers/report.controller';
import { authenticate } from '../middlewares/authenticate';
import { requireAnyPermission, requirePermission } from '../middlewares/requirePermission';

const router = Router();
const { CLASS_SECTION, ENROLLMENT, REPORT_CARD } = PERMISSIONS;

router.use(authenticate());

// Every report takes ?format=json (default) | html (printable A4 in Khmer; print or save as PDF from the browser) | xlsx
router.get('/class-list/:classSectionId', requirePermission(CLASS_SECTION.VIEW, ENROLLMENT.LIST), reportController.classList);
router.get('/gender-statistics', requirePermission(ENROLLMENT.LIST), reportController.genderStatistics);
// VIEW_REPORT_CARDS: homeroom class only (checked in the service); VIEW_ANY_REPORT_CARDS: any class
router.get('/report-cards/:classSectionId', requireAnyPermission(REPORT_CARD.VIEW, REPORT_CARD.VIEW_ANY), reportController.reportCards);

export default router;
