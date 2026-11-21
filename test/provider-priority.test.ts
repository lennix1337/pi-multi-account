import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PROVIDER_PRIORITY,
  MANAGED_GROUPS,
  comparePriority,
  describePriority,
  normalizeGroup,
  normalizePriority,
  priorityRank,
} from "../provider-priority.ts";


test("every rotation slot of one account collapses to a single group", () => {
  assert.equal(normalizeGroup("openai-codex-account-3"), "openai-codex");
  assert.equal(normalizeGroup("kimi-coding-account-2"), "kimi-coding");
  assert.equal(normalizeGroup("cursor-account-2"), "cursor");
  assert.equal(normalizeGroup("openai-codex"), "openai-codex");
});

test("a provider/model pair names its group", () => {
  assert.equal(normalizeGroup("openai-codex/gpt-5.6-sol"), "openai-codex");
  assert.equal(normalizeGroup("anthropic-account-2/claude-opus-5"), "anthropic");
});

test("the nicknames people actually type are understood", () => {
  assert.equal(normalizeGroup("claude"), "anthropic");
  assert.equal(normalizeGroup("Codex"), "openai-codex");
  assert.equal(normalizeGroup("kimi"), "kimi-coding");
  assert.equal(normalizeGroup("  GPT  "), "openai-codex");
});

test("a provider this build has never heard of is still rankable", () => {
  for (const group of ["openrouter", "zai", "minimax", "opencode-go-api", "deepseek"]) {
    assert.equal(normalizeGroup(group), group, `${group} must survive normalisation`);
  }
  assert.equal(normalizeGroup("brand-new-provider-account-4"), "brand-new-provider");
});

test("normalizePriority cleans a list without silently reordering it", () => {
  assert.deepEqual(normalizePriority("codex, claude  kimi"), [
    "openai-codex",
    "anthropic",
    "kimi-coding",
  ]);
  assert.deepEqual(normalizePriority(["cursor", "claude", "cursor"]), ["cursor", "anthropic"]);
  assert.deepEqual(normalizePriority(["", "  ", null as unknown as string]), []);
  assert.deepEqual(normalizePriority(undefined), []);
});


test("the shipped default is the managed families, per-token providers left off the end", () => {
  assert.deepEqual(DEFAULT_PROVIDER_PRIORITY, [...MANAGED_GROUPS]);
  for (const paid of ["openrouter", "zai", "minimax", "opencode-go-api"]) {
    assert.equal(
      priorityRank(paid, DEFAULT_PROVIDER_PRIORITY),
      Number.MAX_SAFE_INTEGER,
      `${paid} bills per token; a flat-rate subscription must be preferred while one is free`,
    );
  }
});

test("an unranked group sorts after every ranked one", () => {
  const ladder = ["anthropic", "openai-codex"];
  assert.ok(comparePriority("anthropic", "openrouter", ladder) < 0);
  assert.ok(comparePriority("openrouter", "openai-codex", ladder) > 0);
});

test("silence is not a preference: two unranked groups are left exactly as they were", () => {
  const ladder = ["anthropic"];
  assert.equal(comparePriority("openrouter", "zai", ladder), 0);
  assert.equal(comparePriority("zai", "openrouter", ladder), 0);
});

test("an empty ladder has no opinion about anything", () => {
  assert.equal(comparePriority("anthropic", "openrouter", []), 0);
  assert.equal(comparePriority("cursor", "anthropic", []), 0);
});

test("the ladder is a total order over the groups it names", () => {
  const ladder = ["cursor", "anthropic", "openai-codex"];
  assert.ok(comparePriority("cursor", "anthropic", ladder) < 0);
  assert.ok(comparePriority("anthropic", "openai-codex", ladder) < 0);
  assert.ok(comparePriority("cursor", "openai-codex", ladder) < 0, "must be transitive");
  assert.equal(comparePriority("cursor", "cursor", ladder), 0);
  for (const [a, b] of [["cursor", "anthropic"], ["anthropic", "openrouter"], ["zai", "zai"]]) {
    assert.equal(
      Math.sign(comparePriority(a, b, ladder)) + 0,
      -Math.sign(comparePriority(b, a, ladder)) + 0,
      `${a} vs ${b}`,
    );
  }
});

test("ranking reads slot names and nicknames, not just canonical ids", () => {
  const ladder = normalizePriority("claude codex");
  assert.equal(priorityRank("anthropic-account-2", ladder), 0);
  assert.equal(priorityRank("openai-codex-account-7/gpt-5.6-terra", ladder), 1);
});


test("the description names the accounts that are not logged in", () => {
  const lines = describePriority(["anthropic", "openrouter"], ["anthropic", "cursor"]);
  assert.match(lines[0], /1\. anthropic$/);
  assert.match(lines[1], /2\. openrouter {2}\(not logged in\)/);
  assert.match(lines[2], /everything else — cursor/);
});

test("the description always ends with the catch-all rung", () => {
  const lines = describePriority(["anthropic"]);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /2\. everything else$/);
});
