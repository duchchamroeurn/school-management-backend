import { Router } from 'express';
import * as authController from '../controllers/auth.controller';
import { authenticate } from '../middlewares/authenticate';

const router = Router();

router.post('/login', authController.login);
router.post('/change-password', authenticate({ allowPendingPasswordChange: true }), authController.changePassword);
router.get('/me', authenticate(), authController.me);

export default router;
