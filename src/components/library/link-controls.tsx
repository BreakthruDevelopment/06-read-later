"use client";

import { useActionState } from "react";
import { type LinkActionState, deleteLinkAction, flagLinkAction, retryLinkAction, tagsLinkAction } from "@/app/links/actions";
import { buttonDanger, buttonPrimary, buttonSecondary, inputClass, labelClass } from "@/components/ui/styles";

function ActionError({ error }: { error?: string }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-sm font-medium text-danger">
      {error}
    </p>
  );
}

export function RetryButton({ id }: { id: string }) {
  const [state, action, pending] = useActionState(retryLinkAction, {} as LinkActionState);
  return (
    <form action={action} className="flex flex-col items-start gap-2">
      <input type="hidden" name="id" value={id} />
      <button type="submit" disabled={pending} className={buttonSecondary}>
        {pending ? "Retrying…" : "Retry"}
      </button>
      <ActionError error={state.error} />
    </form>
  );
}

export function FlagButton({
  id,
  field,
  value,
  label,
  pendingLabel,
  danger = false,
}: {
  id: string;
  field: "archived" | "favorite" | "read";
  value: boolean;
  label: string;
  pendingLabel: string;
  danger?: boolean;
}) {
  const [state, action, pending] = useActionState(flagLinkAction, {} as LinkActionState);
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="field" value={field} />
      <input type="hidden" name="value" value={String(value)} />
      <button type="submit" disabled={pending} className={danger ? buttonDanger : buttonSecondary}>
        {pending ? pendingLabel : label}
      </button>
      <ActionError error={state.error} />
    </form>
  );
}

export function DeleteLinkButton({ id }: { id: string }) {
  const [state, action, pending] = useActionState(deleteLinkAction, {} as LinkActionState);
  return (
    <form action={action} className="flex flex-col items-start gap-2">
      <input type="hidden" name="id" value={id} />
      <button type="submit" disabled={pending} className={buttonDanger}>
        {pending ? "Deleting…" : "Delete"}
      </button>
      <ActionError error={state.error} />
    </form>
  );
}

export function TagEditor({ id, tags }: { id: string; tags: string }) {
  const [state, action, pending] = useActionState(tagsLinkAction, {} as LinkActionState);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="id" value={id} />
      <label className={labelClass}>
        <span>Your tags</span>
        <input name="tags" defaultValue={tags} maxLength={400} autoComplete="off" className={inputClass} />
      </label>
      <p className="text-sm text-muted">Short lowercase slugs, separated by spaces. Up to 10. Tags from the summary stay.</p>
      <button type="submit" disabled={pending} className={buttonPrimary}>
        {pending ? "Saving…" : "Save tags"}
      </button>
      <ActionError error={state.error} />
      {state.ok && <p className="text-sm text-muted">Tags saved.</p>}
    </form>
  );
}
