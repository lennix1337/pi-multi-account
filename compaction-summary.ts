
// external: Pi uses this placeholder when no history remains to summarize.
const NO_HISTORY_PLACEHOLDER = "No prior history.";

export function restorePreviousSummary(summary: string, previousSummary?: string): string {
  if (!summary.startsWith(NO_HISTORY_PLACEHOLDER)) return summary;
  const previous = previousSummary?.trim();
  if (!previous) return summary;
  return `${previous}${summary.slice(NO_HISTORY_PLACEHOLDER.length)}`;
}

/** True when Pi produced a summary that dropped an existing accumulated summary. */
export function droppedPreviousSummary(summary: string, previousSummary?: string): boolean {
  return summary.startsWith(NO_HISTORY_PLACEHOLDER) && !!previousSummary?.trim();
}
