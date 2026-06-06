import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ObjectStorage } from ".";

const bucket = process.env.S3_BUCKET_DOCUMENTS ?? "greenbar-documents";

const client = new S3Client({
  region: process.env.S3_REGION ?? "us-east-1",
  endpoint: process.env.S3_ENDPOINT, // unset in prod → real AWS
  // MinIO needs path-style URLs; AWS S3 v2 prefers virtual-host.
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  credentials:
    process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        }
      : undefined, // fall through to default credential chain
});

export const s3Storage: ObjectStorage = {
  async putObject({ key, body, contentType }) {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  },
  async getObject(key) {
    const res = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!res.Body) throw new Error(`storage: empty body for ${key}`);
    // Body is a Node Readable in this SDK runtime.
    const chunks: Buffer[] = [];
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  },
  async getSignedUrl(key, expiresInSeconds = 300) {
    return getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  },
  async deleteObject(key) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  },
};
