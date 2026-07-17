"use client";

import { useEffect, useState } from "react";

type Stage = 1 | 2;

export default function WorkflowSettingsPage() {
  const [stages, setStages] = useState<Stage | null>(null);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  useEffect(() => {
    fetch("/api/ap/settings/workflow")
      .then((r) => r.json())
      .then((d) => setStages(d.approvalStagesRequired))
      .catch(() => setBanner({ type: "error", msg: "Failed to load settings." }));
  }, []);

  async function save(value: Stage) {
    setSaving(true);
    setBanner(null);
    try {
      const r = await fetch("/api/ap/settings/workflow", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalStagesRequired: value }),
      });
      if (!r.ok) throw new Error();
      setStages(value);
      setBanner({ type: "success", msg: "Workflow setting saved." });
    } catch {
      setBanner({ type: "error", msg: "Failed to save. Please try again." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h2 className="mb-1 text-base font-semibold text-gray-900">Approval workflow</h2>
      <p className="mb-6 text-sm text-gray-500">
        Choose how many approval stages are required before an invoice can be exported.
      </p>

      {banner && (
        <div
          className={`mb-5 rounded-md border px-4 py-3 text-sm ${
            banner.type === "success"
              ? "border-green-200 bg-green-50 text-green-800"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {banner.msg}
        </div>
      )}

      <div className="space-y-3">
        <OptionCard
          title="Single-stage"
          description="Any reviewer or admin can approve an invoice directly."
          selected={stages === 1}
          disabled={saving || stages === null}
          onClick={() => save(1)}
        />
        <OptionCard
          title="Two-stage"
          description="A reviewer approves first, then an admin gives final approval."
          selected={stages === 2}
          disabled={saving || stages === null}
          onClick={() => save(2)}
        />
      </div>
    </div>
  );
}

function OptionCard({
  title,
  description,
  selected,
  disabled,
  onClick,
}: {
  title: string;
  description: string;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-start gap-3 rounded-lg border p-4 text-left transition-colors disabled:opacity-50 ${
        selected
          ? "border-green-600 bg-green-50"
          : "border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50"
      }`}
    >
      <span
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
          selected ? "border-green-600" : "border-gray-300"
        }`}
      >
        {selected && <span className="h-2 w-2 rounded-full bg-green-600" />}
      </span>
      <span>
        <span className={`block text-sm font-medium ${selected ? "text-green-900" : "text-gray-900"}`}>
          {title}
        </span>
        <span className="block text-sm text-gray-500">{description}</span>
      </span>
    </button>
  );
}
