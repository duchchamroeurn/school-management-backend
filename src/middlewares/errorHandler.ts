import { NextFunction, Request, Response } from 'express';
import { Errors } from '../constants/errors';
import { Prisma } from '../generated/prisma/client';
import { HttpError } from '../utils/httpError';

// Safety net for constraint errors a service didn't translate itself
const PRISMA_ERRORS: Record<string, () => HttpError> = {
  P2002: Errors.DUPLICATE,
  P2003: Errors.IN_USE,
  P2025: Errors.RECORD_NOT_FOUND,
};

const send = (res: Response, err: HttpError) => {
  const retryAfter = (err.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
  if (typeof retryAfter === 'number') {
    res.set('Retry-After', String(retryAfter));
  }
  res.status(err.status).json({ status: 'error', code: err.code, message: err.message, details: err.details });
};

export const notFound = (req: Request, _res: Response, next: NextFunction) => {
  next(Errors.ROUTE_NOT_FOUND(req.method, req.path));
};

// Express 5 forwards errors thrown in async handlers here automatically
export const errorHandler = (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    send(res, err);
    return;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError && PRISMA_ERRORS[err.code]) {
    send(res, PRISMA_ERRORS[err.code]());
    return;
  }
  // Malformed JSON body from express.json()
  if (err instanceof SyntaxError && 'body' in err) {
    send(res, Errors.INVALID_JSON());
    return;
  }
  console.error(err);
  send(res, Errors.INTERNAL_ERROR());
};
