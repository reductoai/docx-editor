import { readFile, writeFile } from "node:fs/promises";
import JSZip from "jszip";

/**
 * Strips the specific LibreOffice round-trip artifacts that cause
 * `@eigenpal/docx-js-editor` to mis-render certain paragraphs.
 *
 * When LibreOffice opens a DOCX, "enriches" paragraph-properties with
 * defaults the original didn't have, and re-serializes, some common
 * additions are:
 *
 *   <w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr>
 *
 * which means "no list" — but some renderers (including SuperDoc@0.0.35)
 * treat it as "list with no marker" and collapse the paragraph visually.
 * The tell is Title paragraphs disappearing after the first save-through.
 *
 * We remove `<w:numPr>` blocks that contain `<w:numId w:val="0"/>` from
 * every `<w:pPr>`. Everything else is left alone so semantic content /
 * tracked changes / real list numbering are untouched.
 */
const NUM_PR_NO_LIST_RE =
  /<w:numPr>\s*(?:<w:ilvl\s+w:val="[^"]*"\s*\/>)?\s*<w:numId\s+w:val="0"\s*\/>\s*<\/w:numPr>/g;

// `<w:ind w:hanging="0"/>` is harmless on its own but LibreOffice adds it
// alongside the numPr artifact and it can nudge Title indentation. Drop it.
const HANGING_ZERO_IND_RE =
  /<w:ind\s+w:hanging="0"\s*\/>/g;

export function sanitizeDocumentXml(xml: string): string {
  let out = xml;
  out = out.replace(NUM_PR_NO_LIST_RE, "");
  out = out.replace(HANGING_ZERO_IND_RE, "");
  return out;
}

/**
 * LibreOffice stamps fresh `w:rsidR` / `w:rsidRDefault` / `w:rsidP` /
 * `w:rsidRPr` / `w:rsidTr` attrs on every save, even when the
 * semantic content is unchanged. This strips them so callers can compute
 * a "semantic content" hash that's stable across a pure round-trip save.
 */
const RSID_ATTR_RE = /\s+w:rsid(?:R|P|RDefault|RPr|Tr|Root|Del)="[^"]*"/g;

export function stripRsidAttrs(xml: string): string {
  return xml.replace(RSID_ATTR_RE, "");
}

/**
 * Reads a DOCX zip and returns a normalized representation suitable for
 * semantic-change detection: the sanitized + rsid-stripped contents of
 * `word/document.xml`. Returns an empty string on read / parse failure
 * (caller should treat that as "unchanged"). */
export async function extractSemanticContent(path: string): Promise<string> {
  try {
    const bytes = await readFile(path);
    const zip = await JSZip.loadAsync(bytes);
    const entry = zip.file("word/document.xml");
    if (!entry) return "";
    const xml = await entry.async("string");
    return stripRsidAttrs(sanitizeDocumentXml(xml));
  } catch {
    return "";
  }
}

/**
 * Opens the DOCX zip at `path`, sanitizes word/document.xml in-place, and
 * writes it back. No-op if the file isn't a valid zip or doesn't contain
 * `word/document.xml`.
 */
export async function sanitizeDocxFile(path: string): Promise<boolean> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    return false;
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return false;
  }
  const entry = zip.file("word/document.xml");
  if (!entry) return false;
  const original = await entry.async("string");
  const sanitized = sanitizeDocumentXml(original);
  if (sanitized === original) return false;
  zip.file("word/document.xml", sanitized);
  const rezipped = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  await writeFile(path, rezipped);
  return true;
}
