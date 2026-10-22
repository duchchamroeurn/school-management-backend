// Uploaded documents: checking and normalising them, and keeping them in object storage.
//
//   photo             4x4 student photo (រូបថត ៤x៤): JPEG/PNG ≤ 5 MB, roughly square, at least 300 px.
//                     Stored as a 472×472 px JPEG (4 cm at 300 dpi), so every photo prints the same.
//   birth certificate scan of the សំបុត្រកំណើត: JPEG/PNG/PDF ≤ 10 MB.
//
// Images are re-encoded, which turns them upright (EXIF orientation) and removes their metadata (e.g. the
// GPS position phones record). The original bytes are never stored.
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Errors } from '../constants/errors';
import { Prisma } from '../generated/prisma/client';
import { currentContext } from '../lib/requestContext';
import { deleteObjects, putObject } from '../lib/storage';

const MB = 1024 * 1024;
export const MAX_PHOTO_BYTES = 5 * MB;
export const MAX_DOCUMENT_BYTES = 10 * MB;

export const PHOTO_SIZE_PX = 472; // 4 cm at 300 dpi
const PHOTO_MIN_PX = 300;
// Width ÷ height accepted as "4x4": a little off-square is cropped to square, a 3x4 or 4x6 photo is refused
const PHOTO_MIN_RATIO = 0.8;
const PHOTO_MAX_RATIO = 1.25;

/** A file as received (multipart upload or a file read by an import script) */
export interface Upload {
  buffer: Buffer;
  originalName?: string;
}

/** A checked, normalised file, ready to store */
export interface PreparedFile {
  buffer: Buffer;
  contentType: string;
  extension: string;
  originalName?: string;
}

const IMAGE_TYPES = { jpeg: { contentType: 'image/jpeg', extension: 'jpg' }, png: { contentType: 'image/png', extension: 'png' } } as const;

async function imageFormat(buffer: Buffer) {
  try {
    const meta = await sharp(buffer).metadata();
    // EXIF orientations 5–8 are rotated by 90°: the photo's real width is the stored height
    const rotated = (meta.orientation ?? 1) >= 5;
    return { format: meta.format, width: rotated ? meta.height : meta.width, height: rotated ? meta.width : meta.height };
  } catch {
    return undefined; // not an image sharp can read
  }
}

function assertSize(upload: Upload, field: string, maxBytes: number) {
  if (!upload.buffer.length) throw Errors.FILE_REQUIRED(field);
  if (upload.buffer.length > maxBytes) throw Errors.FILE_TOO_LARGE(field, maxBytes / MB);
}

export async function preparePhoto(upload: Upload, field = 'photo'): Promise<PreparedFile> {
  assertSize(upload, field, MAX_PHOTO_BYTES);
  const image = await imageFormat(upload.buffer);
  if (!image || (image.format !== 'jpeg' && image.format !== 'png') || !image.width || !image.height) {
    throw Errors.FILE_TYPE_NOT_ALLOWED(field, ['JPEG', 'PNG']);
  }
  if (Math.min(image.width, image.height) < PHOTO_MIN_PX) throw Errors.PHOTO_TOO_SMALL(field, image.width, image.height, PHOTO_MIN_PX);
  const ratio = image.width / image.height;
  if (ratio < PHOTO_MIN_RATIO || ratio > PHOTO_MAX_RATIO) throw Errors.PHOTO_NOT_SQUARE(field, image.width, image.height);

  const buffer = await sharp(upload.buffer)
    .rotate()
    .resize(PHOTO_SIZE_PX, PHOTO_SIZE_PX, { fit: 'cover', position: 'centre' })
    .flatten({ background: '#ffffff' }) // a transparent PNG gets a white background, like a printed photo
    .jpeg({ quality: 90, mozjpeg: true })
    .withMetadata({ density: 300 })
    .toBuffer();
  return { buffer, ...IMAGE_TYPES.jpeg, originalName: upload.originalName };
}

export async function prepareDocument(upload: Upload, field: string): Promise<PreparedFile> {
  assertSize(upload, field, MAX_DOCUMENT_BYTES);
  if (upload.buffer.subarray(0, 5).toString('latin1') === '%PDF-') {
    return { buffer: upload.buffer, contentType: 'application/pdf', extension: 'pdf', originalName: upload.originalName };
  }
  const image = await imageFormat(upload.buffer);
  if (image?.format !== 'jpeg' && image?.format !== 'png') throw Errors.FILE_TYPE_NOT_ALLOWED(field, ['JPEG', 'PNG', 'PDF']);
  const encoder = sharp(upload.buffer).rotate();
  const buffer = await (image.format === 'jpeg' ? encoder.jpeg({ quality: 90 }) : encoder.png()).toBuffer();
  return { buffer, ...IMAGE_TYPES[image.format], originalName: upload.originalName };
}

/** A file uploaded to storage, with its StoredFile row (created by the caller inside its transaction) */
export interface UploadedFile {
  id: string;
  objectKey: string;
  record: Prisma.StoredFileUncheckedCreateInput;
}

/** Stores the file under "<folder>/<name>-<id>.<ext>"; the caller writes `record` to the database */
export async function uploadFile(folder: string, name: string, file: PreparedFile): Promise<UploadedFile> {
  const id = randomUUID();
  const objectKey = `${folder}/${name}-${id}.${file.extension}`;
  await putObject(objectKey, file.buffer, file.contentType);
  return {
    id,
    objectKey,
    record: {
      id,
      objectKey,
      contentType: file.contentType,
      size: file.buffer.length,
      sha256: createHash('sha256').update(file.buffer).digest('hex'),
      // Keep only the name, never a client's folder path
      originalName: file.originalName?.split(/[\\/]/).pop()?.slice(0, 255) || null,
      uploadedById: currentContext()?.actor?.id ?? null,
    },
  };
}

/**
 * Uploads the files, then runs the database write. If the write fails, the uploads are removed again, so
 * a failed request leaves nothing behind in the bucket.
 */
export async function withUploads<T>(uploads: (() => Promise<UploadedFile>)[], write: (files: UploadedFile[]) => Promise<T>): Promise<T> {
  const files: UploadedFile[] = [];
  try {
    for (const upload of uploads) files.push(await upload());
    return await write(files);
  } catch (err) {
    await deleteObjects(files.map((f) => f.objectKey));
    throw err;
  }
}

export { deleteObjects };
