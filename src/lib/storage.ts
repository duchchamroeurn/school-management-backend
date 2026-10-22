// Object storage for uploaded files (MinIO in Docker Compose; any S3-compatible service works).
// The bucket is private: files reach clients only through API routes that check permissions first.
import { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { readStorageConfig, StorageConfig } from '../config/storage';
import { Errors } from '../constants/errors';
import { logger } from './logger';

let client: S3Client | undefined;
let settings: StorageConfig | undefined;
let bucketReady: Promise<void> | undefined;

function connect() {
  if (!client) {
    const { config, problems } = readStorageConfig();
    if (problems.length) throw new Error(`File storage is not configured — fix .env (see .env.example):\n  - ${problems.join('\n  - ')}`);
    settings = config;
    client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
      forcePathStyle: true, // MinIO serves buckets as http://host:9000/<bucket>
      maxAttempts: 2,
    });
  }
  return { s3: client, bucket: settings!.bucket };
}

// A storage outage is reported as 503, not as a bug (500)
async function call<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    logger.error(`File storage: ${what} failed`, { err });
    throw Errors.STORAGE_UNAVAILABLE();
  }
}

// Creates the bucket on first use, so a fresh install needs no manual step
function ensureBucket() {
  bucketReady ??= (async () => {
    const { s3, bucket } = connect();
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch (err) {
      if (!(err instanceof S3ServiceException && err.$metadata.httpStatusCode === 404)) throw err;
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      logger.info('File storage: bucket created', { bucket });
    }
  })().catch((err) => {
    bucketReady = undefined; // try again on the next upload
    throw err;
  });
  return bucketReady;
}

export async function putObject(key: string, body: Buffer, contentType: string) {
  await call('upload', async () => {
    await ensureBucket();
    const { s3, bucket } = connect();
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
  });
}

export async function getObject(key: string): Promise<Readable> {
  return call('download', async () => {
    const { s3, bucket } = connect();
    const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!(Body instanceof Readable)) throw new Error(`object ${key} has no body`);
    return Body;
  });
}

/**
 * Removes objects that are no longer referenced (a replaced photo, a deleted student, an upload whose database
 * write failed). Best effort: a failure is logged and left as an orphan in the bucket, never sent to the client,
 * because the database change it follows has already happened.
 */
export async function deleteObjects(keys: string[]) {
  if (!keys.length) return;
  try {
    const { s3, bucket } = connect();
    const { Errors: failed } = await s3.send(
      new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }),
    );
    if (failed?.length) logger.warn('File storage: some objects could not be deleted', { keys: failed.map((f) => f.Key) });
  } catch (err) {
    logger.warn('File storage: objects could not be deleted', { keys, err });
  }
}
