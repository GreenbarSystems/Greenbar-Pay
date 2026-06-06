"use client";

import { useState } from "react";

type UploadState =
  | { kind: "idle" }
  | { kind: "uploading"; filename: string }
  | { kind: "done"; filename: string; documentId: string; dedup: boolean }
  | { kind: "error"; filename: string; message: string };

export default function UploadForm() {
  const [state, setState] = useState<UploadState>({ kind: "idle" });

  async function handleFile(file: File) {
    setState({ kind: "uploading", filename: file.name });
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/invoices/upload", {
      method: "POST",
      body: fd,
      // Client-generated UUID enables safe retry (§4.6).
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setState({
        kind: "error",
        filename: file.name,
        message: body.message ?? body.error ?? `HTTP ${res.status}`,
      });
      return;
    }
    setState({
      kind: "done",
      filename: file.name,
      documentId: body.documentId,
      dedup: !!body.dedup,
    });
  }

  return (
    <div>
      <label
        htmlFor="file"
        className="flex h-48 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-300 bg-white text-center hover:border-gray-400"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files?.[0];
          if (f) void handleFile(f);
        }}
      >
        <span className="text-sm font-medium text-gray-700">
          Drop a file here, or click to choose
        </span>
        <span className="mt-1 text-xs text-gray-500">PDF, PNG, JPEG, TIFF · up to 25 MB</span>
        <input
          id="file"
          type="file"
          className="hidden"
          accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,application/pdf,image/png,image/jpeg,image/tiff"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
        />
      </label>

      <div className="mt-6">
        {state.kind === "uploading" && (
          <p className="text-sm text-gray-600">Uploading {state.filename}…</p>
        )}
        {state.kind === "done" && (
          <div className="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-900">
            <p className="font-medium">{state.filename}</p>
            <p className="text-xs">
              Document {state.documentId} created{state.dedup ? " (duplicate detected — existing record reused)" : ""}.{" "}
              <a href="/inbox" className="underline">View inbox</a>
            </p>
          </div>
        )}
        {state.kind === "error" && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
            <p className="font-medium">{state.filename} — upload failed</p>
            <p className="text-xs">{state.message}</p>
          </div>
        )}
      </div>
    </div>
  );
}
