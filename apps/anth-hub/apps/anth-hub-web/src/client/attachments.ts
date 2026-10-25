// Images attached to a message in the composer. The original file goes to the device, which saves it in the agent's
// project folder; a smaller raster copy (at most 1568 px on the long side, under the device's size limit) is what the
// agent's model is shown, so a large photo never costs a large request, and an SVG logo is shown as a picture.
// Limits are the device's (ATTACHMENT_LIMITS in the SDK).
import { ATTACHMENT_LIMITS, type MessageAttachment } from "@sdk/api";
import { newId } from "./ids";

export const ACCEPT = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"];
export const {
  files: MAX_FILES,
  fileBytes: MAX_FILE_BYTES,
  totalBytes: MAX_TOTAL_BYTES,
  viewBytes: MAX_VIEW_BYTES,
} = ATTACHMENT_LIMITS;
/** Long side of the copy a model is shown. */
const VIEW_EDGE = 1568;
/** Originals at most this big, and no larger than VIEW_EDGE, are shown to the model as they are. */
const VIEW_AS_IS_BYTES = 1.5 * 1024 * 1024;

export interface DraftAttachment {
  /** New for every file the owner adds, so a replaced file is a different attachment (see signature). */
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

/** The image type from the file's first bytes; clipboards and drops sometimes give no type at all. */
export function sniff(head: Uint8Array): string | undefined {
  const starts = (...bytes: number[]) => bytes.every((b, i) => head[i] === b);
  const text = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to));
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (text(0, 6) === "GIF87a" || text(0, 6) === "GIF89a") return "image/gif";
  if (text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return "image/webp";
  if (/<svg[\s>]/i.test(new TextDecoder().decode(head))) return "image/svg+xml";
  return undefined;
}

async function load(url: string) {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

function encode(canvas: HTMLCanvasElement, mimeType: string, quality: number) {
  return new Promise<Blob | null>((r) => canvas.toBlob(r, mimeType, quality));
}

/**
 * A raster copy the model can be shown, or undefined when the original already is one (a PNG, JPEG, WebP or GIF of at
 * most VIEW_EDGE px and VIEW_AS_IS_BYTES). The copy is made smaller, step by step, until it fits MAX_VIEW_BYTES.
 */
async function viewCopy(blob: Blob, url: string): Promise<DraftAttachment["preview"]> {
  const svg = blob.type === "image/svg+xml";
  const img = await load(url);
  // An SVG without width and height has no natural size: draw it at the full edge.
  const w = img.naturalWidth || VIEW_EDGE;
  const h = img.naturalHeight || VIEW_EDGE;
  if (!svg && Math.max(w, h) <= VIEW_EDGE && blob.size <= VIEW_AS_IS_BYTES) return undefined;
  // JPEG for photos; PNG (then WebP, which also keeps transparency) for logos, icons and drawings.
  const types = blob.type === "image/jpeg" ? ["image/jpeg"] : ["image/png", "image/webp"];
  const canvas = document.createElement("canvas");
  for (const edge of [VIEW_EDGE, 1200, 900, 640]) {
    const scale = Math.min(1, edge / Math.max(w, h));
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const type of types) {
      const out = await encode(canvas, type, 0.82);
      // A browser that cannot encode a type hands back PNG instead: only accept what was asked for.
      if (out && out.type === type && out.size <= MAX_VIEW_BYTES)
        return { mimeType: type, data: await base64(out) };
    }
  }
  throw Error("too detailed to preview; attach a smaller image");
}

/** Read a file the owner picked, pasted or dropped. Throws a message to show when it cannot be attached. */
export async function prepare(file: File, current: DraftAttachment[]): Promise<DraftAttachment> {
  const mimeType = ACCEPT.includes(file.type)
    ? file.type
    : sniff(new Uint8Array(await file.slice(0, 4096).arrayBuffer()));
  const ext = (mimeType ?? "image/png")
    .split("/")[1]
    .replace("svg+xml", "svg")
    .replace("jpeg", "jpg");
  const name = file.name || `pasted-image.${ext}`;
  if (!mimeType) throw Error(`${name}: only PNG, JPEG, WebP, GIF and SVG images can be attached`);
  if (current.length >= MAX_FILES) throw Error(`Attach at most ${MAX_FILES} images to one message`);
  if (file.size > MAX_FILE_BYTES)
    throw Error(`${name} is ${sizeLabel(file.size)}; the limit is ${sizeLabel(MAX_FILE_BYTES)}`);
  if (current.reduce((n, a) => n + a.size, file.size) > MAX_TOTAL_BYTES)
    throw Error(`Together the images would be over ${sizeLabel(MAX_TOTAL_BYTES)}`);
  // Typed, so an SVG from a typeless paste still renders as an SVG.
  const blob = file.type === mimeType ? file : new Blob([file], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const [data, preview] = await Promise.all([base64(blob), viewCopy(blob, url)]);
    return { id: newId(), name, mimeType, size: file.size, url, data, preview };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw Error(
      `${name} could not be attached${e instanceof Error && e.message ? `: ${e.message}` : ""}`,
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

/**
 * Identifies a set of attachments, so a retried send reuses its requestId. Built from the drafts' ids: replacing a
 * file, even with another of the same name and size, makes a new id and so a new request.
 */
export const signature = (list: DraftAttachment[]) => list.map((a) => a.id).join("|");

/** Files from a paste or a drop that may be images: typed image/*, or with no type at all (prepare sniffs them). */
export const imageFiles = (items: DataTransfer | null) =>
  [...(items?.files ?? [])].filter((f) => f.type === "" || f.type.startsWith("image/"));
