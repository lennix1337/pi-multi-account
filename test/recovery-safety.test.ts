import assert from "node:assert/strict";
import test from "node:test";
import {
	AutomaticRecoveryArbiter,
	isPolicyRefusal,
	type RecoveryMetadata,
} from "../recovery-safety.ts";

function arbiter(events: RecoveryMetadata[] = []) {
	let nextId = 0;
	return new AutomaticRecoveryArbiter(
		(metadata) => events.push(metadata),
		() => `incident-${++nextId}`,
	);
}

test("automatic recovery admits one root owner and lets only that owner nest", () => {
	const events: RecoveryMetadata[] = [];
	const recovery = arbiter(events);
	const root = recovery.tryAcquire({ category: "quota", provider: "openai-codex", model: "gpt-5.6", sessionId: "session-1" });
	assert.ok(root);
	const nested = recovery.tryAcquire({ category: "context_limit" }, root);
	assert.ok(nested);
	assert.equal(nested.incidentId, root.incidentId);
	assert.equal(recovery.tryAcquire({ category: "transient" }), undefined);

	nested.markRecovering("context_limit");
	nested.release();
	assert.equal(recovery.tryAcquire({ category: "transient" }), undefined);
	root.release();
	assert.deepEqual(events.map(({ phase }) => phase), ["started", "recovering", "completed"]);
	assert.equal(new Set(events.map(({ incidentId }) => incidentId)).size, 1);
});

test("policy refusal is terminal until explicit user control and emits a stopped incident", () => {
	const events: RecoveryMetadata[] = [];
	const recovery = arbiter(events);
	const incidentId = recovery.stopForPolicyRefusal({ provider: "anthropic", model: "claude-4.6", sessionId: "session-1" });

	assert.equal(recovery.policyRefusalStopped, true);
	assert.equal(recovery.tryAcquire({ category: "quota" }), undefined);
	assert.deepEqual(events, [{
		incidentId,
		phase: "stopped",
		category: "policy_refusal",
		provider: "anthropic",
		model: "claude-4.6",
		sessionId: "session-1",
	}]);

	recovery.resetForUserControl();
	const next = recovery.tryAcquire({ category: "transient" });
	assert.ok(next);
	assert.notEqual(next.incidentId, incidentId);
	next.release();
});

test("a refusal inside recovery stops that root incident without completing it", () => {
	const events: RecoveryMetadata[] = [];
	const recovery = arbiter(events);
	const root = recovery.tryAcquire({ category: "context_limit" });
	assert.ok(root);
	root.markRecovering();
	assert.equal(recovery.stopForPolicyRefusal({ provider: "openai-codex", model: "gpt-5.6", sessionId: "session-2" }), root.incidentId);
	root.release();
	assert.deepEqual(events.map(({ phase }) => phase), ["started", "recovering", "stopped"]);
	assert.equal(events.at(-1)?.category, "policy_refusal");
	assert.equal(events.at(-1)?.sessionId, "session-2");
});

test("explicit OptChat policy-stop codes remain terminal without relying on message wording", () => {
	assert.equal(isPolicyRefusal({ code: "OPTCHAT_POLICY_REFUSAL", message: "Compaction stopped" }), true);
	assert.equal(isPolicyRefusal(Object.assign(new Error("Stopped"), { code: "OPTCHAT_POLICY_REFUSAL" })), true);
	assert.equal(isPolicyRefusal({ code: "429", message: "Quota exhausted" }), false);
});

test("policy-refusal classification excludes unrelated provider errors", () => {
	assert.equal(isPolicyRefusal(new Error("Request rejected by the provider's content safety policy")), true);
	assert.equal(isPolicyRefusal("Your request was rejected as a result of our safety system."), true);
	assert.equal(isPolicyRefusal("Your prompt was flagged as potentially violating our Usage Policy."), true);
	assert.equal(isPolicyRefusal("This request was blocked by the safety system."), true);
	assert.equal(isPolicyRefusal("request violates our usage policies"), true);
	assert.equal(isPolicyRefusal("429 rate limit exceeded"), false);
	assert.equal(isPolicyRefusal("401 authentication failed"), false);
	assert.equal(isPolicyRefusal("temporary network error"), false);
});
