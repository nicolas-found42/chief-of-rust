import type { DriveFileClient } from "../intake/drive.js";
import { MAX_UPLOAD_BYTES, isSupportedFileName } from "../text/convert.js";
import type { TranscriptCatalogSource, TranscriptSourceFileMeta } from "./catalog.js";

const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * The production Transcript Catalog source. It reuses the existing Drive
 * intake seam — the same `DriveFileClient` interface the Drive Intake holds —
 * so the Catalog introduces no second Drive client, no credentials path, and
 * no polling of its own: processing passes are driven through the Catalog.
 */
export function createDriveCatalogSource(
  client: DriveFileClient,
  folder: { folderId: string; folderName: string | null },
): TranscriptCatalogSource {
  return {
    async folder() {
      return { folderId: folder.folderId, folderName: folder.folderName };
    },

    async listFiles(): Promise<TranscriptSourceFileMeta[]> {
      const files: TranscriptSourceFileMeta[] = [];
      let pageToken: string | undefined;
      for (;;) {
        const response = await client.files.list({
          q: `'${folder.folderId}' in parents and trashed=false`,
          fields: "nextPageToken, files(id, name, mimeType, webViewLink, modifiedTime, size)",
          pageSize: 100,
          ...(pageToken === undefined ? {} : { pageToken }),
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        });
        for (const file of response.data?.files ?? []) {
          if (typeof file.id !== "string" || typeof file.name !== "string") continue;
          if (file.mimeType === GOOGLE_FOLDER_MIME) continue;
          files.push({
            externalFileId: file.id,
            fileName: file.name,
            sizeBytes: typeof file.size === "string" ? Number(file.size) : null,
            modifiedAt: file.modifiedTime ?? null,
            sourceUrl: file.webViewLink ?? null,
            // A Google Doc has no extension; conversion runs on its exported
            // text — same effective name the Drive Intake synthesizes.
            ...(file.mimeType === GOOGLE_DOC_MIME && !isSupportedFileName(file.name)
              ? { conversionName: `${file.name}.txt` }
              : {}),
          });
        }
        pageToken = response.data?.nextPageToken ?? undefined;
        if (!pageToken) break;
      }
      return files;
    },

    async fetch(externalFileId: string): Promise<Buffer> {
      const meta = await client.files.get({ fileId: externalFileId, fields: "mimeType" });
      const mimeType =
        meta.data && typeof meta.data === "object" && "mimeType" in meta.data
          ? String(meta.data.mimeType)
          : "";
      let bytes: Buffer;
      if (mimeType === GOOGLE_DOC_MIME) {
        const exported = await client.files.export(
          { fileId: externalFileId, mimeType: "text/plain" },
          {
            responseType: "arraybuffer",
          },
        );
        bytes = toBuffer(exported.data);
      } else {
        const fetched = await client.files.get(
          { fileId: externalFileId, alt: "media" },
          {
            responseType: "arraybuffer",
          },
        );
        bytes = toBuffer(fetched.data);
      }
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        throw new Error(`File exceeds the ${MAX_UPLOAD_BYTES}-byte conversion limit`);
      }
      return bytes;
    },
  };
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (typeof data === "string") return Buffer.from(data, "utf8");
  return Buffer.from(JSON.stringify(data), "utf8");
}
