/**
 * Upload media for a message attachment (voice note / file).
 *
 * Two steps, the way the web client does it:
 *   1. POST voyagerVideoDashMediaUploadMetadata?action=upload with the
 *      upload type, byte size and filename → an asset URN and a single-use
 *      PUT URL.
 *   2. PUT the raw bytes to that URL (session cookies + csrf, like the
 *      private-CDN downloads in media.ts).
 * The message is then sent with a renderContentUnions entry referencing the
 * asset URN. Received voice notes store `{ audio: { url, duration } }`
 * (see the JSONL fixtures); the outgoing unit mirrors that with `assetUrn`.
 *
 * NOT YET VERIFIED LIVE — the metadata/PUT shapes follow the web client's
 * attachment flow; `allman send --dry-run` prints exactly what would go out.
 * Override the upload type with ALLMAN_AUDIO_UPLOAD_TYPE / ALLMAN_FILE_UPLOAD_TYPE
 * if LinkedIn's enum differs.
 */
import axios from "axios";
import type { LinkedInApiClient } from "../client.js";
import { buildCookieHeader, getCsrfToken } from "../cookies.js";

const UPLOAD_METADATA_URL =
  "https://www.linkedin.com/voyager/api/voyagerVideoDashMediaUploadMetadata";

export type MediaUploadKind = "audio" | "file";

export function uploadTypeFor(kind: MediaUploadKind): string {
  if (kind === "audio") {
    return process.env.ALLMAN_AUDIO_UPLOAD_TYPE || "MESSAGING_VOICE_MESSAGE";
  }
  return process.env.ALLMAN_FILE_UPLOAD_TYPE || "MESSAGING_FILE_ATTACHMENT";
}

export interface UploadSlot {
  /** urn:li:digitalmediaAsset:… */
  assetUrn: string;
  singleUploadUrl: string;
  /** Headers LinkedIn asks the PUT to carry, when it returns any. */
  singleUploadHeaders: Record<string, string>;
}

interface UploadMetadataResponse {
  data?: { value?: Record<string, unknown>; "*value"?: string };
  value?: Record<string, unknown>;
  included?: Array<Record<string, unknown>>;
}

export function buildUploadMetadataPayload(
  kind: MediaUploadKind,
  fileSize: number,
  filename: string
): { mediaUploadType: string; fileSize: number; filename: string } {
  return { mediaUploadType: uploadTypeFor(kind), fileSize, filename };
}

/** Step 1: ask LinkedIn where to PUT the bytes. */
export async function requestUploadSlot(
  client: LinkedInApiClient,
  kind: MediaUploadKind,
  fileSize: number,
  filename: string
): Promise<UploadSlot> {
  const response = await client.request<UploadMetadataResponse>({
    method: "POST",
    url: UPLOAD_METADATA_URL,
    params: { action: "upload" },
    data: buildUploadMetadataPayload(kind, fileSize, filename),
  });
  const slot = parseUploadSlot(response);
  if (!slot) {
    throw new Error("LinkedIn did not return an upload URL for the attachment");
  }
  return slot;
}

export function parseUploadSlot(response: UploadMetadataResponse): UploadSlot | null {
  let value = response.value ?? response.data?.value;
  if (!value && response.data?.["*value"] && response.included) {
    const ref = response.data["*value"];
    value = response.included.find((e) => e.entityUrn === ref || e.urn === ref);
  }
  if (!value) return null;
  const assetUrn = typeof value.urn === "string" ? value.urn : null;
  const singleUploadUrl = typeof value.singleUploadUrl === "string" ? value.singleUploadUrl : null;
  if (!assetUrn || !singleUploadUrl) return null;
  const headers: Record<string, string> = {};
  const h = value.singleUploadHeaders;
  if (h && typeof h === "object") {
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
      if (typeof v === "string") headers[k] = v;
    }
  }
  return { assetUrn, singleUploadUrl, singleUploadHeaders: headers };
}

/** Step 2: PUT the bytes. */
export async function uploadBytes(
  client: LinkedInApiClient,
  slot: UploadSlot,
  data: Buffer,
  contentType: string
): Promise<void> {
  const jar = client.getJar();
  const cookieHeader = await buildCookieHeader(jar);
  const csrfToken = (await getCsrfToken(jar)) ?? "";
  const response = await axios({
    method: "PUT",
    url: slot.singleUploadUrl,
    headers: {
      cookie: cookieHeader,
      "csrf-token": csrfToken,
      "content-type": contentType,
      referer: "https://www.linkedin.com/messaging/",
      ...slot.singleUploadHeaders,
    },
    data,
    maxBodyLength: Number.POSITIVE_INFINITY,
    timeout: 120_000,
    validateStatus: () => true,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`LinkedIn media upload failed: HTTP ${response.status}`);
  }
}

/** renderContentUnions entry for a voice note. */
export function buildAudioRenderContent(assetUrn: string, durationMs: number): unknown {
  return { audio: { assetUrn, duration: durationMs } };
}

/** renderContentUnions entry for a file attachment. */
export function buildFileRenderContent(
  assetUrn: string,
  byteSize: number,
  mediaType: string,
  name: string
): unknown {
  return { file: { assetUrn, byteSize, mediaType, name } };
}

/** MIME type from a filename, for the PUT and the file render unit. */
export function mimeTypeFor(filename: string): string {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]{1,5})$/)?.[1] ?? "";
  const byExt: Record<string, string> = {
    m4a: "audio/mp4",
    mp4: "video/mp4",
    aac: "audio/aac",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    caf: "audio/x-caf",
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    txt: "text/plain",
    zip: "application/zip",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return byExt[ext] ?? "application/octet-stream";
}
