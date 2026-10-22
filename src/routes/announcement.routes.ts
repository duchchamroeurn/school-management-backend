import { Router } from 'express';
import { PERMISSIONS } from '../constants/permissions';
import * as announcementController from '../controllers/announcement.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/requirePermission';

const router = Router();
const { ANNOUNCEMENT } = PERMISSIONS;

router.use(authenticate());

// Anyone signed in: their own announcements. Registered before /:id so "feed" isn't taken for an id
router.get('/feed', announcementController.feed);
router.get('/feed/unread-count', announcementController.unreadCount);
router.post('/feed/read-all', announcementController.readAll);
router.post('/:id/read', announcementController.read);

router.get('/', requirePermission(ANNOUNCEMENT.MANAGE), announcementController.list);
router.get('/:id', announcementController.get);
router.post('/', requirePermission(ANNOUNCEMENT.MANAGE), announcementController.create);
router.patch('/:id', requirePermission(ANNOUNCEMENT.MANAGE), announcementController.update);
router.delete('/:id', requirePermission(ANNOUNCEMENT.MANAGE), announcementController.remove);

export default router;
