import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const supabaseUrl = process.env.SUPABASE_URL?.trim().replace(/\/$/, "");
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const bucket = process.env.SUPABASE_STORAGE_BUCKET?.trim() || "swiftdrop-private";

export const objectStorageEnabled = Boolean(supabaseUrl && supabaseServiceRoleKey);

const localRoot = path.resolve(process.env.LOCAL_PRIVATE_STORAGE_DIR ?? "uploads/private");

export function safeStorageKey(key: string): string {
  if (key.startsWith("/") || /^[A-Za-z]:[\\/]/.test(key)) throw new Error("Invalid private storage key");
  const normalized = key.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (!normalized || parts.some(part => part === ".." || part === "." || part.length === 0)) {
    throw new Error("Invalid private storage key");
  }
  return normalized;
}

function requireSupabase(): { url: string; key: string } {
  if (!supabaseUrl || !supabaseServiceRoleKey) throw new Error("Supabase private storage is not configured");
  return { url: supabaseUrl, key: supabaseServiceRoleKey };
}

export async function putPrivateObject(key: string, body: Buffer, contentType: string): Promise<void> {
  const safeKey = safeStorageKey(key);
  if (!objectStorageEnabled) {
    if (process.env.NODE_ENV === "production") throw new Error("Supabase private storage is not configured");
    const filePath = path.join(localRoot, safeKey);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, body);
    return;
  }

  const storage = requireSupabase();
  const response = await fetch(storage.url + "/storage/v1/object/" + encodeURIComponent(bucket) + "/" + safeKey.split("/").map(encodeURIComponent).join("/"), {
    method: "POST",
    headers: {
      authorization: "Bearer " + storage.key,
      apikey: storage.key,
      "content-type": contentType,
      "x-upsert": "true"
    },
    body
  });
  if (!response.ok) throw new Error("Supabase Storage upload failed: " + response.status);
}

export async function deletePrivateObject(key: string): Promise<void> {
  const safeKey = safeStorageKey(key);
  if (!objectStorageEnabled) {
    if (process.env.NODE_ENV === "production") throw new Error("Supabase private storage is not configured");
    try { await unlink(path.join(localRoot, safeKey)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return;
  }

  const storage = requireSupabase();
  const response = await fetch(storage.url + "/storage/v1/object/" + encodeURIComponent(bucket) + "/" + safeKey.split("/").map(encodeURIComponent).join("/"), {
    method: "DELETE",
    headers: { authorization: "Bearer " + storage.key, apikey: storage.key }
  });
  if (!response.ok && response.status !== 404) throw new Error("Supabase Storage delete failed: " + response.status);
}

export async function getPrivateObject(key: string): Promise<{ body: Buffer; contentType?: string }> {
  const safeKey = safeStorageKey(key);
  if (!objectStorageEnabled) {
    if (process.env.NODE_ENV === "production") throw new Error("Supabase private storage is not configured");
    const filePath = path.join(localRoot, safeKey);
    const body = await readFile(filePath);
    const extension = path.extname(key).toLowerCase();
    return {
      body,
      contentType: extension === ".png" ? "image/png" : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : extension === ".pdf" ? "application/pdf" : undefined
    };
  }

  const storage = requireSupabase();
  const response = await fetch(storage.url + "/storage/v1/object/" + encodeURIComponent(bucket) + "/" + safeKey.split("/").map(encodeURIComponent).join("/"), {
    headers: { authorization: "Bearer " + storage.key, apikey: storage.key }
  });
  if (!response.ok) throw new Error("Supabase Storage download failed: " + response.status);
  const contentType = response.headers.get("content-type") ?? undefined;
  return { body: Buffer.from(await response.arrayBuffer()), contentType };
}
