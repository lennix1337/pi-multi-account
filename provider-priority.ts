
/** Groups this extension manages directly: OAuth refresh, quota telemetry, live catalogue. */
export const MANAGED_GROUPS = [
  "anthropic",
  "openai-codex",
  "kimi-coding",
  "cursor",
  "qwen",
  "ollama",
] as const;

/**
 * The ladder shipped by default.
 *
 * Flat-rate subscriptions with real quota telemetry first, strongest coding models earliest;
 * then the cheap/local tier; then — by omission — everything else, which is where per-token
 * billing lands. It is the same sequence rotation already used as its final tiebreak, promoted
 * to a stated policy so the cross-family hop stops being decided by whatever the telemetry
 * happened to say at that moment.
 */
export const DEFAULT_PROVIDER_PRIORITY: string[] = [
  "anthropic",
  "openai-codex",
  "kimi-coding",
  "cursor",
  "qwen",
  "ollama",
];

const ALIASES: Record<string, string> = {
  claude: "anthropic",
  opus: "anthropic",
  sonnet: "anthropic",
  codex: "openai-codex",
  chatgpt: "openai-codex",
  gpt: "openai-codex",
  openaicodex: "openai-codex",
  kimi: "kimi-coding",
  k3: "kimi-coding",
  moonshot: "kimi-coding",
  qwen: "qwen",
  alibaba: "qwen",
  dashscope: "qwen",
  glm: "zai",
  zhipu: "zai",
  router: "openrouter",
};

/**
 * Reduce anything the user or the runtime might say to one group name.
 *
 * Handles a bare family, a numbered rotation slot (`kimi-coding-account-2`), a provider/model
 * pair (`openai-codex/gpt-5.6-sol`), and the common nicknames above. Unknown names pass through
 * normalised rather than being rejected: a provider this build has never heard of is exactly the
 * case the old `ProviderFamily[]` type made unrankable, and it must be rankable now.
 */
export function normalizeGroup(raw: string): string {
  const first = String(raw ?? "")
    .trim()
    .split("/")[0]
    .trim()
    .toLowerCase();
  if (!first) return "";
  const base = first.replace(/-account-\d+$/, "");
  if ((MANAGED_GROUPS as readonly string[]).includes(base)) return base;
  const alias = ALIASES[base.replace(/[^a-z0-9]/g, "")];
  return alias ?? base;
}

/**
 * Clean a user-supplied ladder: normalise each entry, drop blanks, drop repeats (first mention
 * wins, because that is what the person meant by putting it there).
 */
export function normalizePriority(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const group = normalizeGroup(item);
    if (!group || out.includes(group)) continue;
    out.push(group);
  }
  return out;
}

/**
 * Position of a group on the ladder. `Number.MAX_SAFE_INTEGER` for anything unranked, so an
 * unranked group sorts after every ranked one without needing a second comparison.
 */
export function priorityRank(group: string, ladder: readonly string[]): number {
  const normalized = normalizeGroup(group);
  const index = ladder.indexOf(normalized);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

/**
 * Comparator contribution for two candidates.
 *
 * Returns 0 — "no opinion, let the next tiebreak decide" — whenever neither side is ranked, and
 * also when both sit at the same position. Only an actual difference in stated preference moves
 * anything, which is what keeps rule 3 honest: an unranked pair is left exactly as it was.
 */
export function comparePriority(
  groupA: string,
  groupB: string,
  ladder: readonly string[],
): number {
  if (ladder.length === 0) return 0;
  const a = priorityRank(groupA, ladder);
  const b = priorityRank(groupB, ladder);
  if (a === b) return 0;
  return a - b;
}

/** One line per rung, for `/multi-account priority` and the status panel. */
export function describePriority(
  ladder: readonly string[],
  present: readonly string[] = [],
): string[] {
  const seen = new Set(present.map(normalizeGroup));
  const lines = ladder.map((group, index) => {
    const mark = seen.size === 0 ? "" : seen.has(group) ? "" : "  (not logged in)";
    return `  ${index + 1}. ${group}${mark}`;
  });
  const rest = [...seen].filter((group) => !ladder.includes(group)).sort();
  if (rest.length > 0) {
    lines.push(`  ${ladder.length + 1}. everything else — ${rest.join(", ")}`);
  } else {
    lines.push(`  ${ladder.length + 1}. everything else`);
  }
  return lines;
}
