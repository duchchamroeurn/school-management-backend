// multipart/form-data parsing for routes that take files. Files are kept in memory (at most a few MB each) and
// checked by the service before anything is stored; text fields arrive in req.body as strings.
import { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import { Errors } from '../constants/errors';
import { MAX_DOCUMENT_BYTES, Upload } from '../services/file.service';

const MB = 1024 * 1024;

/** Accepts one file in each of `fileFields`; any other file field is refused */
export function acceptFiles(...fileFields: string[]): RequestHandler {
  const parse = multer({
    storage: multer.memoryStorage(),
    // Per-type limits (e.g. 5 MB for a photo) are checked by the service; this is the hard ceiling
    // One file more than accepted, so an unexpected file is reported by its field name rather than as "too many files"
    limits: { fileSize: MAX_DOCUMENT_BYTES, files: fileFields.length + 1, fields: 50, fieldSize: 10_000, parts: fileFields.length + 51 },
  }).fields(fileFields.map((name) => ({ name, maxCount: 1 })));

  return (req: Request, res: Response, next: NextFunction) => {
    parse(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        const field = err.field ?? 'file';
        if (err.code === 'LIMIT_FILE_SIZE') return next(Errors.FILE_TOO_LARGE(field, MAX_DOCUMENT_BYTES / MB));
        if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') return next(Errors.UNEXPECTED_FILE(field, fileFields));
        return next(Errors.INVALID_FIELD(field, `is not accepted: ${err.message}`));
      }
      // Malformed multipart body (e.g. cut off, or a wrong boundary)
      if (err instanceof Error) return next(Errors.INVALID_FIELD('body', `is not valid multipart/form-data: ${err.message}`));
      next(err);
    });
  };
}

/** The file sent in `field`, or undefined */
export function uploadedFile(req: Request, field: string): Upload | undefined {
  const file = (req.files as Record<string, Express.Multer.File[]> | undefined)?.[field]?.[0];
  return file && { buffer: file.buffer, originalName: file.originalname };
}
