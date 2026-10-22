import { Router } from 'express';
import { PERMISSIONS } from '../constants/permissions';
import * as calendarController from '../controllers/calendar.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/requirePermission';

const router = Router();
const { CALENDAR } = PERMISSIONS;

router.use(authenticate());

// Anyone signed in may read the calendar: every screen that deals with dates needs it
router.get('/', calendarController.calendar);
router.get('/week', calendarController.week);
router.put('/week', requirePermission(CALENDAR.MANAGE), calendarController.updateWeek);
router.get('/events', calendarController.listEvents);
router.post('/events', requirePermission(CALENDAR.MANAGE), calendarController.createEvent);
router.patch('/events/:id', requirePermission(CALENDAR.MANAGE), calendarController.updateEvent);
router.delete('/events/:id', requirePermission(CALENDAR.MANAGE), calendarController.deleteEvent);

export default router;
