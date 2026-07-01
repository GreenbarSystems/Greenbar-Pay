"use client";

/**
 * Phase 11.1 — Inline PDF rendering for the reviewer.
 *
 * Replaces the prior <iframe> fallback to the browser's native PDF
 * viewer. Native viewers vary across browsers and offer no way to
 * sync UI state (zoom, page) with the reviewer's editing context.
 * react-pdf gives us:
 *   · Deterministic page-by-page render via pdfjs-dist
 *   · Page nav + zoom controls integrated with the surrounding UI
 *   · A text layer that's accessible and selectable
 *   · A graceful failure path: if PDF.js can't load the file (CSP,
 *     corrupted, network), fall back to the signed-URL iframe so
 *     reviewers can still proceed.
 *
 * SSR notes:
 *   · This component is "use client" because react-pdf touches
 *     window/document at import time.
 *   · The parent (ReviewDetailClient) lazy-loads it via next/dynamic
 *     with ssr: false to keep the server bundle clean.
 *   · The PDF.js worker is served from /public/pdf.worker.min.mjs
 *     (copied from node_modules during install, see scripts/copy-pdf-
 *     worker.mjs for the post-install hook).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";

// PDF.js worker. Served from /public — must stay in lockstep with the
// pdfjs-dist version in package.json. The post-install hook re-copies
// it on every npm install; CI verifies the committed copy matches
// (see scripts/copy-pdf-worker.mjs for the version-drift rationale
// and why we use a diff check here instead of Subresource Integrity).
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
const DEFAULT_ZOOM_INDEX = 2; // 1.0×

interface Props {
  fileUrl: string;
  /** Fallback target if PDF.js fails to load AND no refresh handler
   *  recovers. Same signed URL the parent already has. */
  fallbackUrl?: string;
  /**
   * Optional async callback that returns a fresh signed URL. Called
   * exactly once per viewer mount when PDF.js reports a load error
   * (typical cause: the parent's 120-second signed URL expired while
   * the reviewer was reading). If the callback succeeds we re-render
   * with the fresh URL; if it fails (or isn't provided), we fall back
   * to the iframe path.
   */
  onRefreshUrl?: () => Promise<string | null>;
}

export default function PdfViewer({
  fileUrl,
  fallbackUrl,
  onRefreshUrl,
}: Props) {
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX);
  const [loadError, setLoadError] = useState<Error | null>(null);
  // Held in state so an in-place refresh can swap the URL without
  // forcing the parent to re-render.
  const [currentUrl, setCurrentUrl] = useState(fileUrl);
  // Single-shot guard: refresh once per viewer mount. Without this a
  // permanently-bad URL would loop forever on Document → error → refresh.
  const refreshAttemptedRef = useRef(false);

  // If the parent ever swaps fileUrl (navigation between invoices,
  // post-PATCH refresh), reset the in-place state.
  useEffect(() => {
    setCurrentUrl(fileUrl);
    setLoadError(null);
    refreshAttemptedRef.current = false;
  }, [fileUrl]);

  const scale = ZOOM_LEVELS[zoomIndex];

  // Memoize the file URL options so react-pdf's Document doesn't
  // remount on every parent re-render (which would re-fetch the PDF).
  const file = useMemo(() => ({ url: currentUrl }), [currentUrl]);

  const onLoadSuccess = useCallback(({ numPages }: { numPages: number }) => {
    setPageCount(numPages);
    // If the PDF has fewer pages than the current `page` (rare —
    // happens if the parent swaps fileUrl), clamp.
    setPage((p) => Math.min(p, numPages));
  }, []);

  const onLoadError = useCallback(
    async (err: Error) => {
      if (onRefreshUrl && !refreshAttemptedRef.current) {
        refreshAttemptedRef.current = true;
        try {
          const fresh = await onRefreshUrl();
          if (fresh) {
            setCurrentUrl(fresh);
            // Don't set loadError — the new URL will retry the Document
            // load and either succeed or hit onLoadError again (which
            // now falls through to the iframe fallback below).
            return;
          }
        } catch {
          // Fall through to the fallback path.
        }
      }
      setLoadError(err);
    },
    [onRefreshUrl],
  );

  if (loadError && fallbackUrl) {
    // PDF.js failed (network, CSP, or the file isn't a valid PDF).
    // Fall back to the browser's native renderer rather than blocking
    // the reviewer.
    return (
      <div className="space-y-2">
        <p className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
          Inline preview unavailable — falling back to the browser&apos;s
          built-in viewer.
        </p>
        <iframe
          src={fallbackUrl}
          className="h-[80vh] w-full rounded border border-gray-200"
          title="Invoice preview (fallback)"
        />
      </div>
    );
  }

  const canPrev = page > 1;
  const canNext = pageCount !== null && page < pageCount;

  return (
    <div className="flex flex-col gap-2">
      {/* ── Toolbar ────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 rounded border border-gray-200 bg-gray-50 px-2 py-1 text-xs">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={!canPrev}
            className="rounded border border-gray-300 bg-white px-2 py-0.5 text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Previous page"
          >
            ←
          </button>
          <span className="font-mono text-gray-700">
            <input
              type="number"
              min={1}
              max={pageCount ?? 1}
              value={page}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (Number.isNaN(v)) return;
                if (pageCount === null) return;
                setPage(Math.max(1, Math.min(pageCount, v)));
              }}
              className="w-10 rounded border border-gray-300 px-1 text-center text-xs"
              aria-label="Current page"
            />
            {" / "}
            {pageCount ?? "—"}
          </span>
          <button
            type="button"
            onClick={() =>
              setPage((p) => (pageCount === null ? p : Math.min(pageCount, p + 1)))
            }
            disabled={!canNext}
            className="rounded border border-gray-300 bg-white px-2 py-0.5 text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Next page"
          >
            →
          </button>
        </div>

        <div className="h-4 w-px bg-gray-300" aria-hidden />

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setZoomIndex((i) => Math.max(0, i - 1))}
            disabled={zoomIndex === 0}
            className="rounded border border-gray-300 bg-white px-2 py-0.5 text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Zoom out"
          >
            −
          </button>
          <span className="w-10 text-center font-mono text-gray-700">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setZoomIndex((i) => Math.min(ZOOM_LEVELS.length - 1, i + 1))}
            disabled={zoomIndex === ZOOM_LEVELS.length - 1}
            className="rounded border border-gray-300 bg-white px-2 py-0.5 text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => setZoomIndex(DEFAULT_ZOOM_INDEX)}
            className="rounded border border-gray-300 bg-white px-2 py-0.5 text-gray-700 hover:bg-gray-100"
            aria-label="Reset zoom"
          >
            Fit
          </button>
        </div>
      </div>

      {/* ── Page render ────────────────────────────────────────── */}
      <div className="max-h-[78vh] overflow-auto rounded border border-gray-200 bg-gray-100 p-2">
        <Document
          file={file}
          onLoadSuccess={onLoadSuccess}
          onLoadError={onLoadError}
          loading={
            <div className="flex h-[60vh] items-center justify-center text-xs text-gray-500">
              Loading PDF…
            </div>
          }
          error={
            <div className="flex h-[60vh] items-center justify-center text-xs text-red-700">
              Failed to render PDF.
            </div>
          }
          noData={
            <div className="flex h-[60vh] items-center justify-center text-xs text-gray-500">
              No PDF loaded.
            </div>
          }
        >
          <Page
            pageNumber={page}
            scale={scale}
            // Hide annotation layer (form fields etc.) — reviewers
            // don't interact with these and the layer leaks pointer
            // events through the text-selection layer above it.
            renderAnnotationLayer={false}
            className="mx-auto bg-white shadow"
          />
        </Document>
      </div>
    </div>
  );
}
