/**
 * Download message media (images, files, voice notes, video) from LinkedIn's
 * private CDN. These `dms/prv/…` URLs only work with the session cookies, so
 * front-ends never fetch them directly — `allman media` pulls them into the
 * store and they render from disk.
 */
import axios from "axios";
import type { LinkedInApiClient } from "../client.js";
import { buildCookieHeader, getCsrfToken } from "../cookies.js";

export interface DownloadedMedia {
  data: Buffer;
  contentType: string | null;
  bytes: number;
}

export async function downloadMedia(
  client: LinkedInApiClient,
  url: string
): Promise<DownloadedMedia> {
  const jar = client.getJar();
  const cookieHeader = await buildCookieHeader(jar);
  const csrfToken = (await getCsrfToken(jar)) ?? "";
  const response = await axios({
    method: "GET",
    url,
    headers: {
      cookie: cookieHeader,
      "csrf-token": csrfToken,
      referer: "https://www.linkedin.com/messaging/",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    responseType: "arraybuffer",
    maxRedirects: 5,
    timeout: 60_000,
    validateStatus: () => true,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`LinkedIn media download failed: HTTP ${response.status}`);
  }
  const data = Buffer.from(response.data as ArrayBuffer);
  const contentType = (response.headers["content-type"] as string | undefined) ?? null;
  return { data, contentType, bytes: data.length };
}

/** File extension for a downloaded blob: content-type first, then the attachment's mime/name. */
export function extensionFor(
  contentType: string | null,
  fallbackMime?: string | null,
  fallbackName?: string | null
): string {
  const ct = (contentType ?? fallbackMime ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const byMime: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/heic": "heic",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/x-m4a": "m4a",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "application/pdf": "pdf",
    "application/zip": "zip",
    "text/plain": "txt",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  };
  if (byMime[ct]) return byMime[ct];
  const fromName = fallbackName?.match(/\.([A-Za-z0-9]{1,5})$/)?.[1]?.toLowerCase();
  if (fromName) return fromName;
  if (ct.startsWith("image/")) return ct.slice(6);
  if (ct.startsWith("video/")) return ct.slice(6);
  if (ct.startsWith("audio/")) return ct.slice(6);
  return "bin";
}
