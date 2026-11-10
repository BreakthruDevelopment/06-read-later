/** Marks a tag the summary step chose, as opposed to one the reader typed. A label, not a button. */
export function AiTagBadge() {
  return (
    <span className="inline-block whitespace-nowrap rounded-md border border-border bg-background px-1.5 py-0.5 text-xs font-medium text-muted">
      <span aria-hidden="true">AI</span>
      <span className="sr-only">Suggested by AI</span>
    </span>
  );
}
