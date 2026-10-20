import { Router } from 'express';
import * as dashboardController from '../controllers/dashboard.controller';
import { authenticate } from '../middlewares/authenticate';

const router = Router();

// Any signed-in user: each section is gated by its own permission inside the service
router.get('/', authenticate(), dashboardController.get);

export default router;
