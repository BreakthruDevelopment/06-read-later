"use client";

import { useState } from "react";
import { buttonPrimary, buttonSecondary, inputClass, labelClass } from "@/components/ui/styles";

export function CopyBookmarklet({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <label className={labelClass}>
        <span>Bookmarklet</span>
        <textarea readOnly rows={4} value={value} className={`${inputClass} min-h-24 font-mono text-sm`} />
      </label>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className={buttonPrimary}
          onClick={async () => {
            setError(null);
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
            } catch {
              setCopied(false);
              setError("Select the bookmarklet and copy it.");
            }
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <a href={value} className={buttonSecondary}>
          Read Later
        </a>
      </div>
      <p className="text-sm text-muted">On a computer, drag Read Later to the bookmarks bar.</p>
      {error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
