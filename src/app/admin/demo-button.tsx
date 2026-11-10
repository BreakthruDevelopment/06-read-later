"use client";

import { useActionState } from "react";
import { buttonPrimary } from "@/components/ui/styles";
import { type DemoState, loadDemoAction } from "./actions";

export function DemoButton() {
  const [state, action, pending] = useActionState<DemoState, FormData>(loadDemoAction, {});
  return (
    <form action={action} className="flex flex-col items-start gap-2">
      <button type="submit" disabled={pending} className={buttonPrimary}>
        {pending ? "Loading…" : "Load demo workspace"}
      </button>
      {state.error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      )}
      {state.ok && <p className="text-sm text-muted">Loaded {state.links} demo articles into your library.</p>}
    </form>
  );
}
