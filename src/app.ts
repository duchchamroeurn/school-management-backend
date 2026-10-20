import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config/env';
import { isShuttingDown } from './lib/lifecycle';
import { requestContext } from './lib/requestContext';
import { requestLogger } from './middlewares/requestLogger';
import academicYearRoutes from './routes/academic-year.routes';
import assignmentRoutes from './routes/assignment.routes';
import auditLogRoutes from './routes/audit-log.routes';
import authRoutes from './routes/auth.routes';
import classSectionRoutes from './routes/class-section.routes';
import enrollmentRoutes from './routes/enrollment.routes';
import gradeRoutes from './routes/grade.routes';
import gradingRoutes from './routes/grading.routes';
import healthRoutes from './routes/health.routes';
import meRoutes from './routes/me.routes';
import schoolSettingsRoutes from './routes/school-settings.routes';
import staffRoutes from './routes/staff.routes';
import studentRoutes from './routes/student.routes';
import subjectRoutes from './routes/subject.routes';
import teacherRoutes from './routes/teacher.routes';
import { permissionRoutes, roleRoutes } from './routes/role.routes';
import { userRoutes } from './routes/user.routes';
import { errorHandler, notFound } from './middlewares/errorHandler';

const app: Application = express();

// Global Middlewares
// First, so every request (even a malformed one) gets a request id and a log entry
app.use(requestContext);
app.use(requestLogger);
// While shutting down, ask keep-alive clients to reconnect, so the server can close their connections
app.use((_req, res, next) => {
  if (isShuttingDown()) res.setHeader('Connection', 'close');
  next();
});
app.use(helmet());
// Only the frontend origins in CORS_ORIGINS get CORS headers, so browsers block other websites.
// Non-browser clients (Postman, curl) are unaffected.
app.use(cors({ origin: config.corsOrigins }));
app.use(express.json());

app.use('/api/v1/health', healthRoutes);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/me', meRoutes);
app.use('/api/v1/school-settings', schoolSettingsRoutes);
app.use('/api/v1/grades', gradeRoutes);
app.use('/api/v1/subjects', subjectRoutes);
app.use('/api/v1/academic-years', academicYearRoutes);
app.use('/api/v1/class-sections', classSectionRoutes);
app.use('/api/v1/students', studentRoutes);
app.use('/api/v1/staff', staffRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/roles', roleRoutes);
app.use('/api/v1/permissions', permissionRoutes);
app.use('/api/v1/enrollments', enrollmentRoutes);
app.use('/api/v1/assignments', assignmentRoutes);
app.use('/api/v1/teacher', teacherRoutes);
app.use('/api/v1/scores', gradingRoutes);
app.use('/api/v1/audit-logs', auditLogRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
