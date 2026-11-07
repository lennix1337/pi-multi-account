/**
 * Seeded model-based check for the automatic recovery arbiter (recovery-safety.ts).
 *
 * Random sequences of admissions, nested admissions from live or stale leases, recovery marks,
 * releases, policy refusals and user control are run against a small model of the rules: one
 * owner per session, children only under the live owner, policy refusal terminal until explicit
 * user control, and well-formed phases per incident. A failing case prints its seed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	AutomaticRecoveryArbiter,
	type AutomaticRecoveryLease,
	type RecoveryCategory,
	type RecoveryMetadata,
} from "../recovery-safety.ts";

const CASES = 200;
const STEPS = 120;
const CATEGORIES: RecoveryCategory[] = ["quota", "transient", "context_limit"];
const PROVIDERS: Array<string | undefined> = ["anthropic", "openai-codex", undefined];

function rng(seed: number): () => number {
	let state = seed | 0;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function pick<T>(next: () => number, items: readonly T[]): T {
	return items[Math.floor(next() * items.length)]!;
}

test("recovery arbiter follows its rules under random operation sequences: one owner, nested only under the live owner, policy refusal terminal until user control, well-formed phases", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const next = rng(seed);
		const events: RecoveryMetadata[] = [];
		let minted = 0;
		const arbiter = new AutomaticRecoveryArbiter(
			(metadata) => {
				events.push({ ...metadata });
			},
			() => `incident-${++minted}`,
		);
		const leases: AutomaticRecoveryLease[] = [];
		let active: { id: string; owner: AutomaticRecoveryLease; stopped: boolean } | undefined;
		let policyStopped = false;
		let cursor = 0;
		const emitted = () => {
			const fresh = events.slice(cursor);
			cursor = events.length;
			return fresh;
		};

		for (let step = 0; step < STEPS; step++) {
			const label = `seed ${seed} step ${step}`;
			const roll = next();
			if (roll < 0.25) {
				const before = minted;
				const lease = arbiter.tryAcquire({ category: pick(next, CATEGORIES), provider: pick(next, PROVIDERS) });
				if (policyStopped || active) {
					assert.equal(lease, undefined, `${label}: a second owner was admitted`);
					assert.equal(minted, before, `${label}: a refused admission minted an incident`);
					assert.equal(emitted().length, 0, `${label}: a refused admission emitted`);
				} else {
					assert.ok(lease, `${label}: a free arbiter refused an owner`);
					assert.equal(lease.incidentId, `incident-${before + 1}`, label);
					active = { id: lease.incidentId, owner: lease, stopped: false };
					leases.push(lease);
					const phases = emitted().map((event) => [event.incidentId, event.phase]);
					assert.deepEqual(phases, [[lease.incidentId, "started"]], `${label}: admission must start its incident`);
				}
			} else if (roll < 0.4) {
				if (leases.length === 0) continue;
				const parent = pick(next, leases);
				const before = minted;
				const lease = arbiter.tryAcquire({ category: pick(next, CATEGORIES) }, parent);
				if (policyStopped) {
					assert.equal(lease, undefined, `${label}: a lease was granted after a policy refusal`);
					assert.equal(minted, before, label);
				} else if (active) {
					// Under a live incident only that incident's leases nest; a stale parent is refused.
					if (parent.incidentId === active.id) {
						assert.ok(lease, `${label}: the live owner's lease did not nest`);
						assert.equal(lease.incidentId, active.id, label);
						leases.push(lease);
					} else {
						assert.equal(lease, undefined, `${label}: a lease was granted under a stale or foreign parent`);
					}
				} else {
					// No live incident: the call admits a fresh root owner, whatever the parent was.
					assert.ok(lease, `${label}: a free arbiter refused a root admission`);
					assert.equal(lease.incidentId, `incident-${before + 1}`, label);
					active = { id: lease.incidentId, owner: lease, stopped: false };
					leases.push(lease);
					assert.deepEqual(
						emitted().map((event) => [event.incidentId, event.phase]),
						[[lease.incidentId, "started"]],
						`${label}: admission must start its incident`,
					);
					continue;
				}
				assert.equal(emitted().length, 0, `${label}: nesting emitted a transition`);
			} else if (roll < 0.6) {
				if (leases.length === 0) continue;
				const lease = pick(next, leases);
				const live = active !== undefined && lease.incidentId === active.id && !active.stopped;
				lease.markRecovering(pick(next, [undefined, ...CATEGORIES]), pick(next, PROVIDERS), undefined);
				const fresh = emitted();
				if (!live) {
					assert.equal(fresh.length, 0, `${label}: an ended or stopped incident recorded a recovery`);
				} else {
					assert.ok(fresh.length <= 1, `${label}: more than one recovery transition from one mark`);
					for (const event of fresh) {
						assert.equal(event.phase, "recovering", label);
						assert.equal(event.incidentId, active!.id, label);
					}
				}
			} else if (roll < 0.85) {
				if (leases.length === 0) continue;
				const lease = pick(next, leases);
				const complete = next() < 0.8 ? undefined : false;
				const isOwner = active !== undefined && lease === active.owner;
				lease.release(complete === undefined ? undefined : { complete });
				const fresh = emitted().map((event) => event.phase);
				if (isOwner) {
					const expected = !active!.stopped && complete !== false ? ["completed"] : [];
					assert.deepEqual(fresh, expected, `${label}: owner release`);
					active = undefined;
				} else {
					assert.deepEqual(fresh, [], `${label}: a non-owner release changed the incident`);
				}
			} else if (roll < 0.93) {
				if (policyStopped) continue;
				const before = minted;
				const previous = active;
				const alreadyStopped = previous?.stopped === true;
				const id = arbiter.stopForPolicyRefusal({ provider: pick(next, PROVIDERS), sessionId: "session-1" });
				policyStopped = true;
				if (previous) {
					assert.equal(id, previous.id, `${label}: the refusal named another incident`);
					assert.equal(minted, before, `${label}: a refusal inside a live incident minted one`);
					previous.stopped = true;
				} else {
					assert.equal(id, `incident-${before + 1}`, label);
				}
				// The terminal phase is emitted once per incident; a repeat on a stopped incident is silent.
				assert.deepEqual(
					emitted().map((event) => [event.incidentId, event.phase]),
					alreadyStopped ? [] : [[id, "stopped"]],
					`${label}: a refusal must emit one stopped transition per incident`,
				);
			} else {
				arbiter.resetForUserControl();
				policyStopped = false;
				assert.equal(emitted().length, 0, `${label}: user control emitted a transition`);
			}
			assert.equal(arbiter.policyRefusalStopped, policyStopped, `${label}: policy flag`);
		}

		const byIncident = new Map<string, string[]>();
		for (const event of events) byIncident.set(event.incidentId, [...(byIncident.get(event.incidentId) ?? []), event.phase]);
		for (const [incident, phases] of byIncident) {
			const number = Number(incident.slice("incident-".length));
			assert.ok(number >= 1 && number <= minted, `seed ${seed}: event for an incident never minted: ${incident}`);
			const terminal = phases.findIndex((phase) => phase === "stopped" || phase === "completed");
			const started = phases.indexOf("started");
			assert.ok(started === -1 || started === 0, `seed ${seed} ${incident}: started after the first transition`);
			if (terminal >= 0) {
				assert.equal(terminal, phases.length - 1, `seed ${seed} ${incident}: transition after a terminal phase: ${phases.join(",")}`);
				assert.equal(phases.filter((phase) => phase === "stopped" || phase === "completed").length, 1, `seed ${seed} ${incident}: two terminal phases`);
			}
		}
	}
});

test("a repeated refusal on an incident that already stopped emits no second terminal phase", () => {
	const events: RecoveryMetadata[] = [];
	let minted = 0;
	const arbiter = new AutomaticRecoveryArbiter(
		(metadata) => {
			events.push({ ...metadata });
		},
		() => `incident-${++minted}`,
	);
	const owner = arbiter.tryAcquire({ category: "quota", provider: "anthropic" });
	assert.ok(owner);
	const first = arbiter.stopForPolicyRefusal({ provider: "anthropic", sessionId: "session-1" });
	arbiter.resetForUserControl();
	const second = arbiter.stopForPolicyRefusal({ provider: "openai-codex", sessionId: "session-1" });
	owner.release();
	assert.equal(second, first, "the refusal names the incident that is already stopped");
	assert.deepEqual(
		events.filter((event) => event.incidentId === first).map((event) => event.phase),
		["started", "stopped"],
		"a second terminal phase for one incident",
	);
});
