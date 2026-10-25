// Images attached to a message in the composer. The original file goes to the device, which saves it in the agent's
// project folder; a smaller copy (at most 1568 px on the long side) is what the agent's model is shown, so a large
// photo never costs a large request. Limits match the device's (apps/anth-backend/src/attachments.ts).
import type { MessageAttachment } from "@sdk/api";

export const ACCEPT = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"];
export const MAX_FILES = 4;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
/** Long side of the copy a model is shown. */
const VIEW_EDGE = 1568;
/** Originals at most this big, and no larger than VIEW_EDGE, are shown to the model as they are. */
const VIEW_AS_IS_BYTES = 1.5 * 1024 * 1024;

export interface DraftAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** Object URL for the thumbnail; revoke with discard(). */
  url: string;
  data: string;
  preview?: { mimeType: string; data: string };
}

export const sizeLabel = (n: number) =>
  n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? Error("Could not read the file"));
    reader.readAsDataURL(blob);
  });
}

async function load(url: string) {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

/** A copy the model can be shown, or undefined when the original already is one. */
async function viewCopy(file: File, url: string): Promise<DraftAttachment["preview"]> {
  const svg = file.type === "image/svg+xml";
  const img = await load(url);
  // An SVG without width and height has no natural size: draw it at the full edge.
  const w = img.naturalWidth || VIEW_EDGE;
  const h = img.naturalHeight || VIEW_EDGE;
  if (
    !svg &&
    file.type !== "image/gif" &&
    Math.max(w, h) <= VIEW_EDGE &&
    file.size <= VIEW_AS_IS_BYTES
  )
    return undefined;
  if (file.type === "image/gif" && file.size <= VIEW_AS_IS_BYTES) return undefined;
  const scale = Math.min(1, VIEW_EDGE / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  // JPEG for photos; PNG keeps a logo's transparent background.
  const mimeType = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, mimeType, 0.85));
  if (!blob) throw Error("Could not make a preview of the image");
  return { mimeType, data: await base64(blob) };
}

/** Read a file the owner picked, pasted or dropped. Throws a message to show when it cannot be attached. */
export async function prepare(file: File, current: DraftAttachment[]): Promise<DraftAttachment> {
  const name =
    file.name || `pasted-image.${(file.type.split("/")[1] ?? "png").replace("svg+xml", "svg")}`;
  if (!ACCEPT.includes(file.type))
    throw Error(`${name}: only PNG, JPEG, WebP, GIF and SVG images can be attached`);
  if (current.length >= MAX_FILES) throw Error(`Attach at most ${MAX_FILES} images to one message`);
  if (file.size > MAX_FILE_BYTES)
    throw Error(`${name} is ${sizeLabel(file.size)}; the limit is ${sizeLabel(MAX_FILE_BYTES)}`);
  if (current.reduce((n, a) => n + a.size, file.size) > MAX_TOTAL_BYTES)
    throw Error(`Together the images would be over ${sizeLabel(MAX_TOTAL_BYTES)}`);
  const url = URL.createObjectURL(file);
  try {
    const [data, preview] = await Promise.all([base64(file), viewCopy(file, url)]);
    return {
      id: crypto.randomUUID(),
      name,
      mimeType: file.type,
      size: file.size,
      url,
      data,
      preview,
    };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw Error(
      `${name} could not be read as an image${e instanceof Error && e.message ? ` (${e.message})` : ""}`,
    );
  }
}

export const discard = (a: DraftAttachment) => URL.revokeObjectURL(a.url);

/** The wire form for the device. */
export const toWire = (list: DraftAttachment[]): MessageAttachment[] =>
  list.map(({ name, mimeType, data, preview }) => ({
    name,
    mimeType,
    data,
    ...(preview ? { preview } : {}),
  }));

/** Identifies a set of attachments, so a retried send reuses its requestId. */
export const signature = (list: DraftAttachment[]) =>
  list.map((a) => `${a.name}:${a.size}`).join("|");

/** Image files from a paste or a drop. */
export const imageFiles = (items: DataTransfer | null) =>
  [...(items?.files ?? [])].filter((f) => f.type.startsWith("image/"));
