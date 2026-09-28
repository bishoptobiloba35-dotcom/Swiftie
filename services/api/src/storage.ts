import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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

const localRoot = path.resolve(process.env.LOCAL_PRIVATE_STORAGE_DIR ?? "uploads/private");

export function safeStorageKey(key: string): string {
  const normalized = key.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/");
  if (!normalized || parts.some(part => part === ".." || part === "." || part.length === 0)) {
    throw new Error("Invalid private storage key");
  }
  return normalized;
}

function requireStorage(): { client: S3Client; bucket: string } {
  if (!client || !bucket) throw new Error("Private object storage is not configured");
  return { client, bucket };
}

export async function putPrivateObject(key: string, body: Buffer, contentType: string): Promise<void> {
  if (!objectStorageEnabled) {
    if (process.env.NODE_ENV === "production") throw new Error("Private object storage is not configured");
    const filePath = path.join(localRoot, safeStorageKey(key));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, body);
    return;
  }
  const storage = requireStorage();
  await storage.client.send(new PutObjectCommand({
    Bucket: storage.bucket,
    Key: safeStorageKey(key),
    Body: body,
    ContentType: contentType,
    ServerSideEncryption: endpoint ? undefined : "AES256"
  }));
}

export async function getPrivateObject(key: string): Promise<{ body: Buffer; contentType?: string }> {
  if (!objectStorageEnabled) {
    if (process.env.NODE_ENV === "production") throw new Error("Private object storage is not configured");
    const filePath = path.join(localRoot, safeStorageKey(key));
    const body = await readFile(filePath);
    const extension = path.extname(key).toLowerCase();
    return {
      body,
      contentType: extension === ".png" ? "image/png" : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : extension === ".pdf" ? "application/pdf" : undefined
    };
  }
  const storage = requireStorage();
  const response = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key }));
  if (!response.Body) throw new Error("Stored object has no body");
  const bytes = await response.Body.transformToByteArray();
  return { body: Buffer.from(bytes), contentType: response.ContentType };
}
