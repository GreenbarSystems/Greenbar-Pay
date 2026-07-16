"use client";

import Link from "next/link";
import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  id: string;
  invoiceLabel: string;
  confidence: string | null;
}

export function QuickActions({ id, invoiceLabel, confidence }: Props) {
  const router = useRouter();
  const [pending, setPending] = useState<"approve" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reactId = useId();
  // Stable idempotency key for this component's approve action — generated
  // once per mount so a retry sends the same key and the server deduplicates.
  const idemKeyRef = useRef<string | null>(null);
  if (!idemKeyRef.current) {
    idemKeyRef.current = `quick-approve-${id}-${reactId.replace(/:/g, "")}`;
  }

  const pct = confidence ? Math.round(Number(confidence) * 100) : 0;
  const isHighConfidence = pct >= 85;

  if (!isHighConfidence) {
    return (
      <Link
        href={`/review/${id}`}
        aria-label={`Open invoice${invoiceLabel}`}
        className="text-xs font-medium text-green-700 hover:text-green-900"
      >
        Open
      </Link>
    );
  }

  async function handleApprove() {
    setError(null);
    setPending("approve");
    try {
      const res = await fetch(`/api/ap/review/${id}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idemKeyRef.current!,
        },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        router.refresh();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? `Error ${res.status}`);
      }
    } catch {
      setError("Network error");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-1.5">
        <button
          onClick={handleApprove}
          disabled={pending !== null}
          className="rounded-md bg-green-100 px-2.5 py-1 text-[11px] font-medium text-green-800 hover:bg-green-200 disabled:opacity-50"
        >
          {pending === "approve" ? "…" : "Approve"}
        </button>
        <Link
          href={`/review/${id}`}
          aria-label={`Open invoice${invoiceLabel}`}
          className="rounded-md border border-gray-200 px-2.5 py-1 text-[11px] text-gray-500 hover:bg-gray-50"
        >
          Open
        </Link>
      </div>
      {error && <p className="text-[10px] text-red-600">{error}</p>}
    </div>
  );
}
