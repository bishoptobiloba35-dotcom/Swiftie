import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const bucket = process.env.OBJECT_STORAGE_BUCKET?.trim();
const region = process.env.OBJECT_STORAGE_REGION?.trim();
const accessKeyId = process.env.OBJECT_STORAGE_ACCESS_KEY_ID?.trim();
const secretAccessKey = process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY?.trim();
const endpoint = process.env.OBJECT_STORAGE_ENDPOINT?.trim();

export const objectStorageEnabled = Boolean(bucket && region && accessKeyId && secretAccessKey);

const client = objectStorageEnabled
  ? new S3Client({
      region,
      endpoint: endpoint || undefined,
      forcePathStyle: Boolean(endpoint),
      credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! }
    })
  : null;

function requireStorage(): { client: S3Client; bucket: string } {
  if (!client || !bucket) throw new Error("Private object storage is not configured");
  return { client, bucket };
}

export async function putPrivateObject(key: string, body: Buffer, contentType: string): Promise<void> {
  const storage = requireStorage();
  await storage.client.send(new PutObjectCommand({
    Bucket: storage.bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    ServerSideEncryption: endpoint ? undefined : "AES256"
  }));
}

export async function getPrivateObject(key: string): Promise<{ body: Buffer; contentType?: string }> {
  const storage = requireStorage();
  const response = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key }));
  if (!response.Body) throw new Error("Stored object has no body");
  const bytes = await response.Body.transformToByteArray();
  return { body: Buffer.from(bytes), contentType: response.ContentType };
}
