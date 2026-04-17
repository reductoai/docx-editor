import { useRef } from "react";

/**
 * Our stable contract for calling into the DOCX editor from app code.
 *
 * NOTE: The installed `@eigenpal/docx-js-editor@0.0.35` exposes a
 * `DocxEditorRef` with `loadDocumentBuffer` and an async `save()` that
 * returns `ArrayBuffer | null` (not a Blob). It does NOT ship `acceptAll`
 * or `rejectAll` methods at the ref level — those actions live inside the
 * toolbar UI for suggestion mode. We keep the contract below so Units 6/7
 * can rely on a stable surface; the implementation in DocxTitleBar uses
 * feature detection and no-ops with a console.warn when a method is
 * missing on the underlying ref.
 */
export interface SuperDocRefApi {
  loadDocumentBuffer(buf: ArrayBuffer): Promise<void> | void;
  /** Returns the serialized DOCX bytes. Runtime may return ArrayBuffer or Blob. */
  save(): Promise<Blob | ArrayBuffer | null> | Blob | ArrayBuffer | null;
  acceptAll(): void;
  rejectAll(): void;
}

export function useDocxRef() {
  return useRef<SuperDocRefApi | null>(null);
}
