"use client";

import { useEffect, useState } from "react";

export default function PoSettingsPage() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  useEffect(() => {
    fetch("/api/ap/settings/po")
      .then((r) => r.json())
      .then((d) => setEnabled(d.poThreeWayEnabled))
      .catch(() => setBanner({ type: "error", msg: "Failed to load settings." }));
  }, []);

  async function toggle(value: boolean) {
    setSaving(true);
    setBanner(null);
    try {
      const r = await fetch("/api/ap/settings/po", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poThreeWayEnabled: value }),
      });
      if (!r.ok) throw new Error();
      setEnabled(value);
      setBanner({ type: "success", msg: "PO matching setting saved." });
    } catch {
      setBanner({ type: "error", msg: "Failed to save. Please try again." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h2 className="mb-1 text-base font-semibold text-gray-900">PO matching</h2>
      <p className="mb-6 text-sm text-gray-500">
        Control how invoices are matched against purchase orders in the PO register.
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
          title="2-way matching"
          description="Verifies that the invoice PO number matches a PO in the register and the total is within 2%."
          selected={enabled === false}
          disabled={saving || enabled === null}
          onClick={() => toggle(false)}
        />
        <OptionCard
          title="3-way matching"
          description="Additionally requires receipt confirmation before an invoice can be approved, and warns when received quantities are short."
          selected={enabled === true}
          disabled={saving || enabled === null}
          onClick={() => toggle(true)}
        />
      </div>

      {enabled === true && (
        <p className="mt-4 text-xs text-gray-400">
          Note: the global <code className="rounded bg-gray-100 px-1 py-0.5">PO_THREE_WAY_ENABLED</code> environment
          variable overrides this setting when set to <code className="rounded bg-gray-100 px-1 py-0.5">true</code>.
        </p>
      )}
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
