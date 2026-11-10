"use client";

import { useActionState, useRef } from "react";
import { buttonPrimary, inputClass } from "@/components/ui/styles";
import { type LinkActionState, saveLinkAction } from "@/app/links/actions";

export function SaveLinkForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState<LinkActionState, FormData>(async (prev, form) => {
    const result = await saveLinkAction(prev, form);
    if (result.ok) formRef.current?.reset();
    return result;
  }, {});

  return (
    <form ref={formRef} action={action} className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
      <label className="block min-w-0 flex-1 space-y-1 text-sm font-medium">
        <span>URL</span>
        <input name="url" type="url" required maxLength={2048} placeholder="https://example.com/article" className={inputClass} />
      </label>
      <button type="submit" disabled={pending} className={buttonPrimary}>
        {pending ? "Saving…" : "Save"}
      </button>
      {state.error && (
        <p role="alert" className="text-sm font-medium text-danger sm:basis-full">
          {state.error}
        </p>
      )}
    </form>
  );
}
