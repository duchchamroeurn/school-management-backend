import { NextFunction, Request, Response } from 'express';
import { logger } from '../lib/logger';
import { currentContext } from '../lib/requestContext';

// Health checks run every few seconds; log them only at debug level
const QUIET_PATHS = new Set(['/api/v1/health']);

// One log entry per request when the response is sent. Use after requestContext.
// The query string is left out: searches contain student and staff names.
export const requestLogger = (req: Request, res: Response, next: NextFunction) => {
  const startedAt = process.hrtime.bigint();
  const context = currentContext(); // authenticate() adds the actor to this same object later

  res.on('finish', () => {
    const path = req.originalUrl.split('?')[0];
    const fields = {
      ...(context && { requestId: context.requestId }),
      method: req.method,
      path,
      status: res.statusCode,
      durationMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e5) / 10,
      ip: req.ip,
      ...(context?.actor && { userId: context.actor.id, username: context.actor.username }),
    };
    if (res.statusCode >= 500) logger.error('request', fields);
    else if (res.statusCode >= 400) logger.warn('request', fields);
    else if (QUIET_PATHS.has(path)) logger.debug('request', fields);
    else logger.info('request', fields);
  });
  next();
};
