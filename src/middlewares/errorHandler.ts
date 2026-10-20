import { NextFunction, Request, Response } from 'express';
import { Prisma } from '../generated/prisma/client';
import { HttpError } from '../utils/httpError';

const PRISMA_ERRORS: Record<string, { status: number; code: string; message: string }> = {
  P2002: { status: 409, code: 'DUPLICATE', message: 'A record with these values already exists' },
  P2003: { status: 409, code: 'IN_USE', message: 'This record is referenced by other records' },
  P2025: { status: 404, code: 'NOT_FOUND', message: 'Record not found' },
};

export const notFound = (req: Request, _res: Response, next: NextFunction) => {
  next(new HttpError(404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`));
};

// Express 5 forwards errors thrown in async handlers here automatically
export const errorHandler = (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ status: 'error', code: err.code, message: err.message, details: err.details });
    return;
  }
  // Safety net for constraint errors a service didn't translate itself
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const mapped = PRISMA_ERRORS[err.code];
    if (mapped) {
      res.status(mapped.status).json({ status: 'error', code: mapped.code, message: mapped.message });
      return;
    }
  }
  // Malformed JSON body from express.json()
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ status: 'error', code: 'INVALID_JSON', message: 'Request body is not valid JSON' });
    return;
  }
  console.error(err);
  res.status(500).json({ status: 'error', code: 'INTERNAL_ERROR', message: 'Something went wrong' });
};
