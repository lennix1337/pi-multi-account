import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyChildUsability,
  defaultRouteWarning,
  describeChildUsability,
  type ChildUsability,
  type SlotChildFacts,
} from "../child-usability.ts";

const facts = (over: Partial<SlotChildFacts> = {}): SlotChildFacts => ({
  slotId: "openai-codex-account-4",
  credential: "oauth",
  builtin: false,
  ...over,
});

test("the measured failure: an alias slot with an OAuth credential is NOT child-usable", () => {
  const verdict = classifyChildUsability(facts());
  assert.equal(verdict.usable, false);
  if (verdict.usable) return;
  assert.match(verdict.reason, /No API key found/);
  assert.match(verdict.remedy, /loopback proxy|placeholder/i);
});

test("a built-in provider is usable whatever we publish — Pi owns its auth flow", () => {
  const verdict = classifyChildUsability(facts({ slotId: "openai-codex", builtin: true }));
  assert.equal(verdict.usable, true);
  if (!verdict.usable) return;
  assert.equal(verdict.via, "builtin");
});

test("the measured failure: built-in Anthropic on a subscription token is NOT child-usable", () => {
  const verdict = classifyChildUsability(facts({ slotId: "anthropic", builtin: true }));
  assert.equal(verdict.usable, false);
  if (verdict.usable) return;
  assert.match(verdict.reason, /third-party/i);
  assert.match(verdict.remedy, /loopback|placeholder/i);
});

test("a published parent route rescues built-in Anthropic, which is the whole point of it", () => {
  const verdict = classifyChildUsability(
    facts({
      slotId: "anthropic",
      builtin: true,
      publishedApiKey: "pi-multi-account-proxy",
      publishedBaseUrl: "http://127.0.0.1:41977/anthropic",
    }),
  );
  assert.equal(verdict.usable, true);
  if (!verdict.usable) return;
  assert.equal(verdict.via, "parent-proxy");
});

test("an API-key slot is usable: Pi resolves it through its own credential store", () => {
  const verdict = classifyChildUsability(facts({ slotId: "zai", credential: "api_key" }));
  assert.equal(verdict.usable, true);
  if (!verdict.usable) return;
  assert.equal(verdict.via, "api-key");
});

test("a published cursor-proxy does not rescue Cursor OAuth: Pi still never consults it", () => {
  const verdict = classifyChildUsability(
    facts({
      slotId: "cursor",
      credential: "oauth",
      publishedApiKey: "cursor-proxy",
      publishedBaseUrl: "http://127.0.0.1:61070/v1",
    }),
  );
  assert.equal(verdict.usable, false);
  if (verdict.usable) return;
  assert.match(verdict.reason, /No API key found/);
});

test("the Cursor pattern is what makes an OAuth account reachable by a child", () => {
  // external: Pi consults models.json apiKey only when the stored credential is an API key.
  const verdict = classifyChildUsability(
    facts({
      slotId: "cursor",
      credential: "api_key",
      publishedApiKey: "cursor-proxy",
      publishedBaseUrl: "http://127.0.0.1:57387/v1",
    }),
  );
  assert.equal(verdict.usable, true);
  if (!verdict.usable) return;
  assert.equal(verdict.via, "parent-proxy");
  assert.match(verdict.note, /never leaves the parent/);
});

test("a published placeholder does not rescue an OAuth blob: Pi never consults it", () => {
  // external: Pi does not resolve OAuth credentials for models.json-only providers without an OAuth method.
  const verdict = classifyChildUsability(
    facts({
      publishedApiKey: "pi-multi-account-proxy",
      publishedBaseUrl: "http://127.0.0.1:41977/openai-codex-account-4",
    }),
  );
  assert.equal(verdict.usable, false);
  if (verdict.usable) return;
  assert.match(verdict.reason, /No API key found/);
});

test("a placeholder key pointing off this machine is not a child route, because OAuth still wins", () => {
  const verdict = classifyChildUsability(
    facts({ publishedApiKey: "cursor-proxy", publishedBaseUrl: "https://api.anthropic.com" }),
  );
  assert.equal(verdict.usable, false);
  if (verdict.usable) return;
  assert.match(verdict.reason, /No API key found/);
});

test("localhost and ::1 count as this machine; a lookalike hostname does not", () => {
  for (const baseUrl of ["http://localhost:1234/v1", "http://127.0.0.1:1/v1", "http://[::1]:9/v1"]) {
    const verdict = classifyChildUsability(
      facts({ credential: "api_key", publishedApiKey: "k", publishedBaseUrl: baseUrl }),
    );
    assert.equal(verdict.usable, true, baseUrl);
    if (!verdict.usable) continue;
    assert.equal(verdict.via, "parent-proxy", baseUrl);
  }
  for (const baseUrl of ["http://127.0.0.1.evil.tld/v1", "http://notlocalhost/v1", "gibberish"]) {
    const verdict = classifyChildUsability(
      facts({ credential: "api_key", publishedApiKey: "k", publishedBaseUrl: baseUrl }),
    );
    assert.equal(verdict.usable, true, baseUrl);
    if (!verdict.usable) continue;
    assert.equal(verdict.via, "api-key", baseUrl);
  }
});

test("no credential at all is reported as such, not as an auth-flow problem", () => {
  const verdict = classifyChildUsability(facts({ credential: "none" }));
  assert.equal(verdict.usable, false);
  if (verdict.usable) return;
  assert.match(verdict.reason, /No credential/i);
});


test("an unusable saved global default warns only about bare unpinned children", () => {
  const warning = defaultRouteWarning("openai-codex-account-4", () =>
    classifyChildUsability(facts()),
  );
  assert.ok(warning, "an unusable saved default must produce a warning");
  assert.match(warning, /saved global default/);
  assert.match(warning, /without --model/);
  assert.match(warning, /first-available provider/);
  assert.match(warning, /broker\/subagent children are unaffected/);
});

test("a usable saved default produces no noise", () => {
  const warning = defaultRouteWarning("openai-codex", () =>
    classifyChildUsability(facts({ slotId: "openai-codex", builtin: true })),
  );
  assert.equal(warning, undefined);
});

test("no saved default, or an unknown one, is silence rather than a guess", () => {
  assert.equal(defaultRouteWarning(undefined, () => undefined), undefined);
  assert.equal(defaultRouteWarning("mystery", () => undefined), undefined);
});


test("the report puts unusable slots first and is otherwise stable", () => {
  const verdicts: ChildUsability[] = [
    classifyChildUsability(facts({ slotId: "zai", credential: "api_key" })),
    classifyChildUsability(facts({ slotId: "openai-codex-account-4" })),
    classifyChildUsability(facts({ slotId: "anthropic", builtin: true })),
    classifyChildUsability(facts({ slotId: "kimi-coding-account-2" })),
  ];
  const lines = describeChildUsability(verdicts);
  assert.match(lines[0], /anthropic|kimi-coding-account-2|openai-codex-account-4/);
  assert.match(lines[0], /NOT usable/);
  assert.match(lines[1], /NOT usable/);
  assert.equal(lines.filter((l) => /NOT usable/.test(l)).length, 3);
  assert.deepEqual(describeChildUsability(verdicts), lines);
  assert.deepEqual(describeChildUsability([...verdicts].reverse()), lines);
});
