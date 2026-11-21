import assert from "node:assert/strict";
import test from "node:test";
import {
  PI_ASSUMPTIONS,
  PUBLISHED_FILES,
  checkAuthShape,
  checkModelsShape,
  checkSettingsShape,
  checkSettingsTracksActive,
  describeContractDrift,
  observedAssumptions,
  piAutoPersistsSelectedModel,
  piAbortStopsAgentRetry,
  piHasContextWithSystem,
} from "../pi-contract.ts";


test("the interface is exactly the three files Pi publishes", () => {
  assert.deepEqual([...PUBLISHED_FILES], ["auth.json", "models.json", "settings.json"]);
});

test("every assumption says whether Pi promised it, where, and what breaks", () => {
  assert.ok(PI_ASSUMPTIONS.length > 0);
  for (const assumption of PI_ASSUMPTIONS) {
    assert.ok(assumption.id && assumption.fact, `${assumption.id}: fact required`);
    assert.ok(["documented", "observed"].includes(assumption.kind), assumption.id);
    assert.ok(assumption.surface.length > 10, `${assumption.id}: needs a surface`);
    assert.ok(assumption.breaks.length > 10, `${assumption.id}: needs a consequence`);
  }
  const ids = PI_ASSUMPTIONS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, "ids must be unique");
});

test("only genuinely unpromised assumptions remain on the manual re-check list", () => {
  const observed = observedAssumptions().map((a) => a.id);
  assert.deepEqual(observed, ["oauth-needs-provider-declared-flow"]);
  assert.equal(
    PI_ASSUMPTIONS.find((assumption) => assumption.id === "settings-default-model-versioned-persistence")?.kind,
    "documented",
  );
});

test("model-default persistence is gated at Pi 0.84.3", () => {
  assert.equal(piAutoPersistsSelectedModel("0.84.0"), true);
  assert.equal(piAutoPersistsSelectedModel("v0.84.2"), true);
  assert.equal(piAutoPersistsSelectedModel("0.84.3"), false);
  assert.equal(piAutoPersistsSelectedModel("0.84.4"), false);
  assert.equal(piAutoPersistsSelectedModel("0.85.0"), false);
  assert.equal(piAutoPersistsSelectedModel("1.0.0"), false);
  assert.equal(piAutoPersistsSelectedModel("unknown"), false);
});


test("auth.json: the ordinary shape passes", () => {
  const verdict = checkAuthShape({
    anthropic: { type: "oauth", access: "x", refresh: "y" },
    zai: { type: "api_key", key: "k" },
  });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.problems, []);
});

test("auth.json: an unfamiliar credential kind is reported, not silently skipped", () => {
  const verdict = checkAuthShape({ future: { type: "passkey" } });
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems[0], /future.*passkey/);
});

test("auth.json: the check never carries a secret in its output", () => {
  const verdict = checkAuthShape({
    anthropic: { type: "nonsense", access: "SUPER-SECRET-TOKEN", refresh: "ALSO-SECRET" },
  });
  const rendered = JSON.stringify(verdict);
  assert.equal(rendered.includes("SUPER-SECRET-TOKEN"), false, "a diagnostic must not leak a token");
  assert.equal(rendered.includes("ALSO-SECRET"), false);
});


test("models.json: a bare model id string is caught, and the message says how bad it is", () => {
  const verdict = checkModelsShape({
    providers: { "kimi-coding-account-2": { api: "anthropic-messages", models: ["k3", "k3-256k"] } },
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems[0], /2 model entries are a bare string/);
  assert.match(verdict.problems[0], /ENTIRE file/);
});

test("models.json: model objects pass, and an absent registry is not a fault", () => {
  assert.equal(
    checkModelsShape({ providers: { zai: { models: [{ id: "glm-5.2" }] } } }).ok,
    true,
  );
  assert.equal(checkModelsShape({}).ok, true);
});

test("models.json: structural nonsense is reported rather than thrown", () => {
  assert.equal(checkModelsShape("not json").ok, false);
  assert.equal(checkModelsShape({ providers: [] }).ok, false);
  assert.equal(checkModelsShape({ providers: { a: { models: "k3" } } }).ok, false);
});


test("settings.json: both keys present is the healthy case", () => {
  const verdict = checkSettingsShape({ defaultProvider: "openai-codex-account-4", defaultModel: "gpt-5.6-sol" });
  assert.equal(verdict.ok, true);
});

test("settings.json: both saved-default keys may be absent on session-scoped Pi", () => {
  const verdict = checkSettingsShape({ theme: "dark" });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.problems, []);
});

test("settings.json: a half-written saved default is invalid", () => {
  const verdict = checkSettingsShape({ defaultProvider: "anthropic" });
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems[0], /both be strings or both be absent/);
});

test("settings.json: a wrong type is caught even when the key exists", () => {
  assert.equal(checkSettingsShape({ defaultProvider: 42, defaultModel: "m" }).ok, false);
});


const active = { provider: "openai-codex-account-4", id: "gpt-5.6-sol" };

test("settings.json naming the running model is the whole point, and passes", () => {
  const verdict = checkSettingsTracksActive(
    { defaultProvider: "openai-codex-account-4", defaultModel: "gpt-5.6-sol" },
    active,
  );
  assert.equal(verdict.ok, true);
});

test("a stale default is caught, and the message names both models", () => {
  const verdict = checkSettingsTracksActive(
    { defaultProvider: "anthropic", defaultModel: "claude-opus-5" },
    active,
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems[0], /anthropic\/claude-opus-5/);
  assert.match(verdict.problems[0], /openai-codex-account-4\/gpt-5\.6-sol/);
  assert.match(verdict.problems[0], /child/);
});

test("the model alone differing is still a mismatch", () => {
  const verdict = checkSettingsTracksActive(
    { defaultProvider: "openai-codex-account-4", defaultModel: "gpt-5.6-mini" },
    active,
  );
  assert.equal(verdict.ok, false);
});

test("missing saved defaults are a legacy mismatch only when this gated check is requested", () => {
  const verdict = checkSettingsTracksActive({ theme: "dark" }, active);
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems[0], /\(unset\)\/\(unset\)/);
  assert.match(verdict.problems[0], /Pi <=0\.84\.2/);
});

test("a broken settings file reports the shape problem rather than a bogus mismatch", () => {
  const verdict = checkSettingsTracksActive("nonsense", active);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.problems, ["not a JSON object"]);
});


test("a healthy install says nothing at all", () => {
  const verdicts = [
    checkAuthShape({ zai: { type: "api_key" } }),
    checkModelsShape({}),
    checkSettingsShape({ defaultProvider: "p", defaultModel: "m" }),
  ];
  assert.equal(describeContractDrift(verdicts), undefined);
});

test("drift names the file, the problem, and why nothing warned us", () => {
  const message = describeContractDrift([
    checkModelsShape({ providers: { a: { models: ["x"] } } }),
    checkSettingsShape({ defaultProvider: "p", defaultModel: "m" }),
  ]);
  assert.ok(message);
  assert.match(message, /models\.json/);
  assert.match(message, /bare string/);
  assert.match(message, /carries no version|no version/);
  assert.equal(/settings\.json/.test(message), false, "a healthy file must not appear in the report");
});

test("an extension abort cancels Pi's own retry only from Pi 0.86.0", () => {
  assert.equal(piAbortStopsAgentRetry("0.85.1"), false);
  assert.equal(piAbortStopsAgentRetry("0.86.0"), true);
  assert.equal(piAbortStopsAgentRetry("1.0.0"), true);
  assert.equal(piAbortStopsAgentRetry("unknown"), false);
});

test("context_with_system is used only on hosts that emit it (Pi 0.87.0+)", () => {
  assert.equal(piHasContextWithSystem("0.86.1"), false);
  assert.equal(piHasContextWithSystem("0.87.0"), true);
  assert.equal(piHasContextWithSystem("v0.99.2"), true);
  assert.equal(piHasContextWithSystem("1.3.0"), true);
  assert.equal(piHasContextWithSystem("unknown"), false);
});
