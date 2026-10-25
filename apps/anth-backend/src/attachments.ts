// Images the owner attaches to a chat message (a logo, an icon, a screenshot).
//
// Each file is saved into the agent's project folder, under .anth/uploads/<date>/, so every team member can use it
// with their own tools (copy it into public/, read an SVG). The folder is listed in the repo's local git exclude, so a
// ship never commits an upload by accident; a developer copies the file into the product on purpose.
//
// When the agent's model can see images, the message also carries each image (a downscaled preview from the hub when
// the original is large, and a raster picture of an SVG), so the agent knows what it looks like before it hands the
// work out.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { ATTACHMENT_LIMITS, type MessageAttachment } from "../../anth-sdk/src/api.js";
import { invalid } from "./errors.js";

const run = promisify(execFile);

export const {
  files: MAX_ATTACHMENTS,
  fileBytes: MAX_FILE_BYTES,
  totalBytes: MAX_TOTAL_BYTES,
  viewBytes: MAX_VIEW_BYTES,
  bodyLimit: MESSAGE_BODY_LIMIT,
} = ATTACHMENT_LIMITS;

/** Accepted types and the extension a saved file gets. */
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};
/**
 * Raster types a model can be shown. An SVG file is text to a model: it is shown only through a raster `preview` from
 * the client (the hub draws one), and its file stays readable to every agent.
 */
const VIEWABLE = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const LABEL: Record<string, string> = {
  "image/png": "PNG image",
  "image/jpeg": "JPEG image",
  "image/webp": "WebP image",
  "image/gif": "GIF image",
  "image/svg+xml": "SVG image",
};

export interface ParsedAttachment {
  name: string;
  mimeType: string;
  bytes: Buffer;
  /** What the model is shown, when it can see images: the preview, or the original when it is small enough. */
  view?: { mimeType: string; data: string };
}

export interface SavedAttachment {
  /** Path relative to the agent's folder, e.g. .anth/uploads/2026-10-25/logo.png. */
  path: string;
  absolute: string;
  mimeType: string;
  size: number;
  view?: { mimeType: string; data: string };
}

/** True when the bytes really are a file of this type, so a renamed file is never passed on as an image. */
export function looksLike(mimeType: string, bytes: Buffer) {
  const head = (n: number) => bytes.subarray(0, n);
  switch (mimeType) {
    case "image/png":
      return head(8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/jpeg":
      return head(3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    case "image/gif":
      return ["GIF87a", "GIF89a"].includes(head(6).toString("latin1"));
    case "image/webp":
      return head(4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP";
    case "image/svg+xml":
      return /<svg[\s>]/i.test(head(4096).toString("utf8"));
    default:
      return false;
  }
}

function decode(data: unknown, what: string, max: number) {
  if (typeof data !== "string" || !data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
    throw invalid(`${what} must be base64 data`);
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > max) throw invalid(`${what} is ${mb(bytes.length)}; the limit is ${mb(max)}`);
  return bytes;
}

const mb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** A safe file name with the extension of its type: no folders, no odd characters. */
export function safeName(name: string, mimeType: string) {
  const stem = basename(name.replaceAll("\\", "/"))
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 60);
  return `${stem || "image"}.${EXTENSIONS[mimeType]}`;
}

/** Validate a message's attachments (undefined or an empty list is none). Throws 400s the owner can act on. */
export function parseAttachments(value: unknown): ParsedAttachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid("attachments must be a list");
  if (value.length > MAX_ATTACHMENTS) throw invalid(`Attach at most ${MAX_ATTACHMENTS} files to one message`);
  let total = 0;
  return value.map((raw: Partial<MessageAttachment>, i) => {
    const what = `Attachment ${i + 1}${typeof raw?.name === "string" ? ` (${raw.name.slice(0, 60)})` : ""}`;
    if (!raw || typeof raw !== "object") throw invalid(`${what} must be an object`);
    if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 200) throw invalid(`${what} needs a file name`);
    if (typeof raw.mimeType !== "string" || !EXTENSIONS[raw.mimeType])
      throw invalid(`${what}: only PNG, JPEG, WebP, GIF and SVG images can be attached`);
    const bytes = decode(raw.data, what, MAX_FILE_BYTES);
    if (!looksLike(raw.mimeType, bytes)) throw invalid(`${what} is not a ${LABEL[raw.mimeType]}`);
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw invalid(`The attachments add up to more than ${mb(MAX_TOTAL_BYTES)}`);
    let view: ParsedAttachment["view"];
    if (raw.preview !== undefined) {
      const p = raw.preview;
      if (!p || typeof p !== "object" || typeof p.mimeType !== "string" || !VIEWABLE.has(p.mimeType))
        throw invalid(`${what}: the preview must be a PNG, JPEG, WebP or GIF image`);
      const preview = decode(p.data, `${what} preview`, MAX_VIEW_BYTES);
      if (!looksLike(p.mimeType, preview)) throw invalid(`${what}: the preview is not a ${LABEL[p.mimeType]}`);
      view = { mimeType: p.mimeType, data: p.data as string };
    } else if (VIEWABLE.has(raw.mimeType) && bytes.length <= MAX_VIEW_BYTES) {
      view = { mimeType: raw.mimeType, data: raw.data as string };
    }
    return { name: safeName(raw.name, raw.mimeType), mimeType: raw.mimeType, bytes, view };
  });
}

/**
 * Keep .anth/ out of the folder's repo through its local exclude file (never committed, never shared). The pattern has
 * no leading slash, so it also covers an agent working in a subfolder of the repo (<sub>/.anth/); a root-only
 * "/.anth/" line from an earlier version does not count.
 */
async function excludeFromGit(dir: string) {
  try {
    const { stdout } = await run("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: dir, timeout: 10_000 });
    const file = resolve(dir, stdout.trim());
    const current = await readFile(file, "utf8").catch(() => "");
    if (current.split("\n").some((line) => [".anth/", "**/.anth/", ".anth"].includes(line.trim()))) return;
    await mkdir(resolve(file, ".."), { recursive: true });
    await appendFile(file, `${current && !current.endsWith("\n") ? "\n" : ""}# Anth-Agent uploads and scratch files\n.anth/\n`);
  } catch {
    // Not a git repo (or no git): nothing to keep out.
  }
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/**
 * Save attachments under <dir>/.anth/uploads/<date>/. A file of the same name and the same bytes is reused, so a
 * retried send or the same logo sent twice never makes copies; a different file of the same name gets -2, -3, ….
 */
export async function saveAttachments(dir: string, list: ParsedAttachment[], now = new Date()): Promise<SavedAttachment[]> {
  if (!list.length) return [];
  const day = now.toISOString().slice(0, 10);
  const folder = join(dir, ".anth", "uploads", day);
  await mkdir(folder, { recursive: true });
  await excludeFromGit(dir);
  const saved: SavedAttachment[] = [];
  for (const a of list) {
    const dot = a.name.lastIndexOf(".");
    for (let n = 1; ; n++) {
      const name = n === 1 ? a.name : `${a.name.slice(0, dot)}-${n}${a.name.slice(dot)}`;
      const absolute = join(folder, name);
      try {
        await writeFile(absolute, a.bytes, { flag: "wx", mode: 0o644 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const existing = await readFile(absolute).catch(() => undefined);
        if (!existing || sha(existing) !== sha(a.bytes)) continue;
      }
      saved.push({ path: relative(dir, absolute), absolute, mimeType: a.mimeType, size: a.bytes.length, view: a.view });
      break;
    }
  }
  return saved;
}

type Block = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** The message the agent gets: the owner's text, where the files are, and the images when its model can see them. */
export function attachmentMessage(text: string, saved: SavedAttachment[], canSeeImages: boolean): string | Block[] {
  if (!saved.length) return text;
  const shown = canSeeImages ? saved.filter((s) => s.view) : [];
  const lines = [
    text.trim(),
    "",
    `The owner attached ${saved.length === 1 ? "this file" : `${saved.length} files`}, saved in the project folder so the whole team can use ${saved.length === 1 ? "it" : "them"}:`,
    ...saved.map((s) => `- ${s.path} (${LABEL[s.mimeType]}, ${mb(s.size)})`),
    "Uploads are git-ignored: to use one in the product, copy it into the project (for example into public/) and commit that copy. Pass the paths on when you delegate.",
  ];
  if (shown.length)
    lines.push(
      shown.length === saved.length
        ? "You can see the images below."
        : `You can see ${shown.map((s) => basename(s.path)).join(", ")} below; open the others with your tools (an SVG is text you can read).`,
    );
  else if (!canSeeImages) lines.push("Your model cannot see images: work from the files and the owner's words, or ask a teammate whose model can.");
  else lines.push("Open them with your tools (an SVG is text you can read).");
  const intro = lines.join("\n").trim();
  return shown.length
    ? [{ type: "text", text: intro }, ...shown.map((s) => ({ type: "image" as const, data: s.view!.data, mimeType: s.view!.mimeType }))]
    : intro;
}

/** JSON for clients: image data in entries replaced by a marker (the hub shows text; files are in the project). */
export function withoutImageData<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, v) =>
      v && typeof v === "object" && v.type === "image" && typeof v.data === "string" && typeof v.mimeType === "string" && v.data
        ? { type: "image", mimeType: v.mimeType, data: "", omitted: true }
        : v,
    ),
  ) as T;
}
