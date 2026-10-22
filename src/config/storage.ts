// Object storage settings (MinIO, or any S3-compatible service). Kept apart from config/env.ts because the
// import and demo scripts store files too, and they run without the server's secrets. env.ts reports the
// problems at server startup; the scripts get them when they first store a file.
export interface StorageConfig {
  endpoint: string; // e.g. http://minio:9000
  region: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

// S3 bucket naming rules: 3–63 lower-case letters, digits, dots and hyphens
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export function readStorageConfig(env: NodeJS.ProcessEnv = process.env): { config: StorageConfig; problems: string[] } {
  const problems: string[] = [];
  const value = (name: string) => {
    const v = env[name]?.trim();
    if (!v) problems.push(`${name} is required`);
    return v ?? '';
  };

  const endpoint = value('S3_ENDPOINT').replace(/\/+$/, '');
  if (endpoint) {
    try {
      const url = new URL(endpoint);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
    } catch {
      problems.push(`S3_ENDPOINT must be an http(s) URL, e.g. http://localhost:9000 (got "${endpoint}")`);
    }
  }
  const accessKey = value('S3_ACCESS_KEY');
  const secretKey = value('S3_SECRET_KEY');
  if (secretKey && secretKey.length < 8) problems.push('S3_SECRET_KEY must be at least 8 characters (a MinIO requirement)');
  const bucket = env.S3_BUCKET?.trim() || 'school-files';
  if (!BUCKET_NAME.test(bucket)) problems.push(`S3_BUCKET must be 3–63 lower-case letters, digits, "." or "-" (got "${bucket}")`);

  return { config: { endpoint, region: env.S3_REGION?.trim() || 'us-east-1', accessKey, secretKey, bucket }, problems };
}
