/**
 * Seeded property and model-based checks for the completion route planner.
 *
 * Each property states its oracle on its own terms (the documented precedence, the budgets,
 * the anti-ping-pong window) instead of re-running the implementation's branches. A failing case
 * prints its seed; the same seed replays the exact input.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	classifyRouteAttempt,
	rankAutomaticRouteCandidates,
	selectOperationRoute,
	type RankAutomaticRouteOptions,
	type RouteAttemptFact,
	type RouteDecision,
	type RouteFailureKind,
	type RouteFailurePatterns,
	type RouteModelRef,
	type RouteRequestFact,
	type ScoredRouteCandidate,
} from "../completion-route-planner.ts";
import { priorityRank } from "../provider-priority.ts";

type Candidate = ScoredRouteCandidate<RouteModelRef>;
type Options = RankAutomaticRouteOptions;

const CASES = 200;
const NOW = 1_000_000;
const ANTI_PING_PONG_MS = 1_000;
const GROUPS = ["anthropic", "openai-codex", "kimi-coding", "cursor", "qwen", "ollama", "openrouter", "zai"];

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

function shuffle<T>(next: () => number, items: readonly T[]): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	return out;
}

// ---------------------------------------------------------------------------
// Account ranking: rankAutomaticRouteCandidates
// ---------------------------------------------------------------------------

function genRanking(seed: number): { scored: Candidate[]; options: Options } {
	const next = rng(seed);
	const currentGroup = pick(next, GROUPS);
	const count = 1 + Math.floor(next() * 8);
	const scored: Candidate[] = Array.from({ length: count }, (_, rotIndex) => {
		const group = next() < 0.4 ? currentGroup : pick(next, GROUPS);
		const sameFamily = group === currentGroup;
		const provider = `${group}-account-${rotIndex + 1}`;
		return {
			model: { provider, id: `model-${Math.floor(next() * 2)}` },
			provider,
			remaining: next() < 0.4 ? 0 : 1 + Math.floor(next() * 100_000),
			rotIndex,
			rank: Math.floor(next() * 4),
			lastRefusalAt: Math.floor(next() * 4) * 1_000,
			predictedBusy: next() < 0.3,
			confirmed: next() < 0.4,
			group,
			sameFamily,
			sameModel: sameFamily && next() < 0.5,
		};
	});
	const lastLeft = pick(next, scored);
	return {
		scored: shuffle(next, scored),
		options: {
			preferLatestModel: next() < 0.5,
			preferSameIdentity: next() < 0.7,
			providerPriority: shuffle(next, GROUPS).slice(0, Math.floor(next() * (GROUPS.length + 1))),
			availableNowOnly: next() < 0.3,
			lastLeftProvider: next() < 0.5 ? lastLeft.provider : undefined,
			lastLeftAt: NOW - Math.floor(next() * 2 * ANTI_PING_PONG_MS),
			antiPingPongMs: ANTI_PING_PONG_MS,
			now: NOW,
		},
	};
}

/**
 * The documented precedence, one dimension at a time: same model, same family, liveness
 * (confirmed, then not predicted busy), the provider ladder, last refusal, recency, rotation.
 * Liveness sits above the ladder on purpose: evidence about a specific account beats a
 * preference about its category (see the comment in index.ts next to the ladder comparator).
 */
function precedes(a: Candidate, b: Candidate, o: Options): boolean {
	const dimensions: Array<[number, number]> = [];
	if (o.preferSameIdentity) {
		dimensions.push([Number(!a.sameModel), Number(!b.sameModel)], [Number(!a.sameFamily), Number(!b.sameFamily)]);
	}
	dimensions.push(
		[Number(!a.confirmed), Number(!b.confirmed)],
		[Number(a.predictedBusy), Number(b.predictedBusy)],
		[priorityRank(a.group, o.providerPriority), priorityRank(b.group, o.providerPriority)],
		[a.lastRefusalAt, b.lastRefusalAt],
	);
	if (o.preferLatestModel) dimensions.push([a.rank, b.rank]);
	dimensions.push([a.rotIndex, b.rotIndex]);
	for (const [x, y] of dimensions) if (x !== y) return x < y;
	return false;
}

const byPrecedence = (o: Options) => (a: Candidate, b: Candidate) => (precedes(a, b, o) ? -1 : precedes(b, a, o) ? 1 : 0);

/** The oracle: free accounts in precedence order, minus the just-left one inside its window; else nothing (availableNowOnly) or every account by recovery time. */
function expectedRanking(scored: readonly Candidate[], o: Options): string[] {
	const free = scored.filter((c) => c.remaining === 0);
	const pingPong =
		o.lastLeftProvider !== undefined &&
		o.lastLeftAt !== undefined &&
		o.now - o.lastLeftAt < o.antiPingPongMs &&
		free.length > 1;
	let chosen = free;
	if (pingPong) {
		const others = free.filter((c) => c.provider !== o.lastLeftProvider);
		if (others.length > 0) chosen = others;
	}
	if (chosen.length > 0) return [...chosen].sort(byPrecedence(o)).map((c) => c.provider);
	if (o.availableNowOnly) return [];
	return [...scored]
		.sort((a, b) => a.remaining - b.remaining || byPrecedence(o)(a, b))
		.map((c) => c.provider);
}

const servedProviders = (scored: readonly Candidate[], o: Options) =>
	rankAutomaticRouteCandidates(scored, o).map((model) => model.provider);

test("failover serves exactly the expected accounts in documented order; a free account is never replaced by [] or a cooled-down one", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const { scored, options } = genRanking(seed);
		const served = servedProviders(scored, options);
		assert.deepEqual(served, expectedRanking(scored, options), `seed ${seed}: served order differs from the documented order`);
		if (scored.some((c) => c.remaining === 0)) {
			assert.ok(served.length > 0, `seed ${seed}: an account is free but none was served`);
			for (const provider of served) {
				const picked = scored.find((c) => c.provider === provider)!;
				assert.equal(picked.remaining, 0, `seed ${seed}: cooled-down ${provider} served while a free account existed`);
			}
		}
	}
});

test("failover decision is deterministic and independent of the order the accounts were listed in", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const { scored, options } = genRanking(seed);
		const once = servedProviders(scored, options);
		assert.deepEqual(servedProviders(scored, options), once, `seed ${seed}: same input, different decision`);
		assert.deepEqual(servedProviders(shuffle(rng(seed * 7919), scored), options), once, `seed ${seed}: listing order changed the decision`);
	}
});

test("when identity is preferred, same-model accounts lead the free list and same-family accounts precede other families", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const { scored, options } = genRanking(seed);
		if (!options.preferSameIdentity) continue;
		const served = rankAutomaticRouteCandidates(scored, options);
		const byProvider = new Map(scored.map((c) => [c.provider, c]));
		const flags = served.map((m) => byProvider.get(m.provider)!);
		if (!flags.every((c) => c.remaining === 0)) continue; // cooled-down fallback is ordered by recovery time instead
		const firstOther = flags.findIndex((c) => !c.sameModel);
		if (firstOther >= 0) {
			assert.ok(flags.slice(firstOther).every((c) => !c.sameModel), `seed ${seed}: a same-model account came after another account`);
		}
		const firstNonFamily = flags.findIndex((c) => !c.sameFamily);
		if (firstNonFamily >= 0) {
			assert.ok(flags.slice(firstNonFamily).every((c) => !c.sameFamily), `seed ${seed}: a same-family account came after another family`);
		}
	}
});

test("the ladder never overrides liveness or family: a confirmed account is not placed behind an unconfirmed one of the same tier", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const { scored, options } = genRanking(seed);
		const served = rankAutomaticRouteCandidates(scored, options);
		const byProvider = new Map(scored.map((c) => [c.provider, c]));
		const flags = served.map((m) => byProvider.get(m.provider)!);
		if (!flags.every((c) => c.remaining === 0)) continue;
		for (let i = 0; i < flags.length; i++) {
			for (let j = i + 1; j < flags.length; j++) {
				const earlier = flags[i]!;
				const later = flags[j]!;
				if (earlier.sameModel !== later.sameModel || earlier.sameFamily !== later.sameFamily) continue;
				assert.ok(!(later.confirmed && !earlier.confirmed), `seed ${seed}: unconfirmed ${earlier.provider} ahead of confirmed ${later.provider}`);
				assert.ok(!(!later.predictedBusy && earlier.predictedBusy && earlier.confirmed === later.confirmed), `seed ${seed}: busy ${earlier.provider} ahead of free ${later.provider}`);
			}
		}
	}
});

test("anti-ping-pong: the account just left is not served again while another free account exists in the window", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const { scored, options } = genRanking(seed);
		const inWindow =
			options.lastLeftProvider !== undefined &&
			options.lastLeftAt !== undefined &&
			options.now - options.lastLeftAt < options.antiPingPongMs;
		const freeOthers = scored.filter((c) => c.remaining === 0 && c.provider !== options.lastLeftProvider);
		if (!inWindow || freeOthers.length === 0) continue;
		assert.ok(!servedProviders(scored, options).includes(options.lastLeftProvider!), `seed ${seed}: just-left ${options.lastLeftProvider} served inside the window`);
	}
});

test("cooldown expiry over time: at every instant the served accounts are exactly those whose cooldown has ended, and the fallback recovers soonest first", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const next = rng(seed);
		const count = 1 + Math.floor(next() * 6);
		const until = new Map<string, number>();
		const providers = Array.from({ length: count }, (_, i) => `${pick(next, GROUPS)}-account-${i + 1}`);
		for (const provider of providers) until.set(provider, Math.floor(next() * 50_000));
		const options: Options = {
			preferLatestModel: false,
			preferSameIdentity: false,
			providerPriority: [],
			availableNowOnly: false,
			antiPingPongMs: ANTI_PING_PONG_MS,
			now: 0,
		};
		for (let t = 0; t <= 60_000; t += 1 + Math.floor(next() * 3_000)) {
			const scored: Candidate[] = providers.map((provider, rotIndex) => ({
				model: { provider, id: "m" },
				provider,
				remaining: Math.max(0, until.get(provider)! - t),
				rotIndex,
				rank: 0,
				lastRefusalAt: 0,
				predictedBusy: false,
				confirmed: false,
				group: provider,
				sameFamily: false,
				sameModel: false,
			}));
			const served = servedProviders(scored, { ...options, now: t });
			const expired = providers.filter((p) => until.get(p)! <= t);
			if (expired.length > 0) {
				assert.ok(served.every((p) => until.get(p)! <= t), `seed ${seed} t ${t}: a cooling account served while one had expired`);
				assert.deepEqual([...served].sort(), [...expired].sort(), `seed ${seed} t ${t}: expired set not served in full`);
			} else {
				const remainingOf = served.map((p) => Math.max(0, until.get(p)! - t));
				assert.deepEqual(remainingOf, [...remainingOf].sort((a, b) => a - b), `seed ${seed} t ${t}: all spent, recovery order not soonest first`);
				assert.equal(served.length, providers.length, `seed ${seed} t ${t}: a spent account was dropped from the fallback`);
			}
		}
	}
});

// ---------------------------------------------------------------------------
// Failure classification: classifyRouteAttempt
// ---------------------------------------------------------------------------

const PATTERNS: RouteFailurePatterns = {
	contextOverflow: ["context_length_exceeded"],
	ignore: ["ignored-by-policy"],
	auth: ["invalid api key"],
	limit: ["quota exceeded"],
	model: ["model not found"],
	transient: ["upstream timeout"],
};

const CLASSIFY_WORDS = [
	"context_length_exceeded",
	"ignored-by-policy",
	"invalid api key",
	"quota exceeded",
	"model not found",
	"upstream timeout",
	"cursor run stalled, timed out",
	"boom",
];
const STATUSES: Array<number | undefined> = [undefined, 200, 401, 402, 403, 404, 429, 500, 503];
const STOP_REASONS = ["error", "error", "error", "error", "stop", "aborted", "route_unavailable"];

function genAttempt(next: () => number): RouteAttemptFact {
	const words = Array.from({ length: 1 + Math.floor(next() * 3) }, () => pick(next, CLASSIFY_WORDS));
	const status = pick(next, STATUSES);
	return {
		operationId: "op",
		purpose: "memory/review",
		attempt: 1,
		model: { provider: next() < 0.7 ? "anthropic" : "cursor-account-1", id: "m" },
		dispatched: true,
		stopReason: pick(next, STOP_REASONS),
		errorMessage: next() < 0.1 ? undefined : words.join(next() < 0.5 ? " " : ", "),
		response: status === undefined ? undefined : { status, retryAfterMs: next() < 0.2 ? 250 : undefined },
	};
}

/** The precedence written as a list: each rule is consulted only when the ones above it did not decide. */
function specKind(a: RouteAttemptFact): RouteFailureKind {
	if (a.stopReason === "route_unavailable") return "route_unavailable";
	if (a.stopReason === "aborted") return "aborted";
	if (a.stopReason !== "error") return "success";
	const text = (a.errorMessage ?? "").trim().toLowerCase();
	const has = (words: readonly string[]) => words.some((word) => text.includes(word));
	const status = a.response?.status;
	const cursorStall =
		a.model.provider.startsWith("cursor") &&
		((text.includes("cursor run stalled") && text.includes("timed out")) ||
			(text.includes("produced no output") && text.includes("timed out")));
	if (has(PATTERNS.contextOverflow)) return "context_overflow";
	if (text && has(PATTERNS.ignore)) return "unhandled";
	if (status === 401 || has(PATTERNS.auth)) return "auth";
	if (status === 402 || status === 403 || status === 429 || has(PATTERNS.limit)) return "limit";
	if (has(PATTERNS.model)) return "model";
	if (cursorStall) return "cursor_stall";
	if (status !== undefined && status >= 500) return "transient";
	if (has(PATTERNS.transient)) return "transient";
	return "unhandled";
}

test("failure classification follows its precedence and is case-insensitive", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const attempt = genAttempt(rng(seed));
		const kind = classifyRouteAttempt(attempt, PATTERNS);
		assert.equal(kind, specKind(attempt), `seed ${seed}: ${JSON.stringify(attempt)}`);
		const shouted = { ...attempt, errorMessage: attempt.errorMessage?.toUpperCase() };
		assert.equal(classifyRouteAttempt(shouted, PATTERNS), kind, `seed ${seed}: case changed the verdict`);
	}
});

test("classification pins: a context overflow beats auth, ignored text beats auth and limit, a 401 is auth whatever the text says", () => {
	const error = (errorMessage: string, status?: number): RouteAttemptFact => ({
		operationId: "op",
		purpose: "memory/review",
		attempt: 1,
		model: { provider: "anthropic", id: "m" },
		dispatched: true,
		stopReason: "error",
		errorMessage,
		response: status === undefined ? undefined : { status },
	});
	assert.equal(classifyRouteAttempt(error("context_length_exceeded invalid api key", 401), PATTERNS), "context_overflow");
	assert.equal(classifyRouteAttempt(error("ignored-by-policy quota exceeded", 429), PATTERNS), "unhandled");
	assert.equal(classifyRouteAttempt(error("quota exceeded", 401), PATTERNS), "auth");
	assert.equal(classifyRouteAttempt(error("upstream timeout", 500), PATTERNS), "transient");
	assert.equal(classifyRouteAttempt(error("quota exceeded", 500), PATTERNS), "limit");
	assert.equal(classifyRouteAttempt(error("boom", 403), PATTERNS), "limit");
	assert.equal(classifyRouteAttempt(error("boom"), PATTERNS), "unhandled");
});

// ---------------------------------------------------------------------------
// Operation state machine: selectOperationRoute, driven to its end
// ---------------------------------------------------------------------------

const POOL: RouteModelRef[] = [
	{ provider: "anthropic", id: "a" },
	{ provider: "openai-codex", id: "b" },
	{ provider: "cursor-account-1", id: "c" },
	{ provider: "kimi-coding", id: "d" },
	{ provider: "zai", id: "e" },
];

const OUTCOMES: Array<Pick<RouteAttemptFact, "stopReason" | "errorMessage" | "response">> = [
	{ stopReason: "stop" },
	{ stopReason: "error", errorMessage: "quota exceeded", response: { status: 429 } },
	{ stopReason: "error", errorMessage: "invalid api key", response: { status: 401 } },
	{ stopReason: "error", errorMessage: "model not found" },
	{ stopReason: "error", errorMessage: "upstream timeout", response: { status: 503, retryAfterMs: 250 } },
	{ stopReason: "error", errorMessage: "upstream timeout" },
	{ stopReason: "error", errorMessage: "context_length_exceeded" },
	{ stopReason: "error", errorMessage: "something odd" },
	{ stopReason: "error", errorMessage: "cursor run stalled, timed out" },
	{ stopReason: "aborted" },
	{ stopReason: "route_unavailable" },
];

const TRANSIENT_DELAY_MS = 1_000;
const sameRoute = (a: RouteModelRef, b: RouteModelRef) => a.provider === b.provider && a.id === b.id;
const TRANSIENT_KINDS: RouteFailureKind[] = ["transient", "cursor_stall"];

test("an operation's route sequence respects failure kinds, the same-route budget and fallback order, and always ends", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const next = rng(seed);
		const preferredModels = Array.from({ length: Math.floor(next() * 3) }, () => pick(next, POOL));
		const sessionModel = next() < 0.5 ? pick(next, POOL) : undefined;
		const orderedCandidates = Array.from({ length: Math.floor(next() * 5) }, () => pick(next, POOL));
		const maxSameRouteTransientRetries = Math.floor(next() * 3);
		const universe: RouteModelRef[] = [];
		for (const route of [...preferredModels, ...(sessionModel ? [sessionModel] : []), ...orderedCandidates]) {
			if (!universe.some((known) => sameRoute(known, route))) universe.push(route);
		}
		const attempts: RouteAttemptFact[] = [];
		const decide = (previous: RouteAttemptFact | undefined): RouteDecision => {
			const request: RouteRequestFact = {
				operationId: "op",
				purpose: "memory/review",
				attempt: attempts.length + 1,
				maxAttempts: 99,
				deadlineAt: Number.MAX_SAFE_INTEGER,
				sessionModel,
				preferredModels,
				attempts: [...attempts],
				previous,
			};
			return selectOperationRoute({
				request,
				orderedCandidates,
				patterns: PATTERNS,
				maxSameRouteTransientRetries,
				transientRetryDelayMs: TRANSIENT_DELAY_MS,
			});
		};
		const sameRouteTransientFailures = (route: RouteModelRef) =>
			attempts.filter((a) => sameRoute(a.model, route) && TRANSIENT_KINDS.includes(classifyRouteAttempt(a, PATTERNS))).length;
		const bound = universe.length * (maxSameRouteTransientRetries + 1) + 1;

		let previous: RouteAttemptFact | undefined;
		for (let step = 0; ; step++) {
			assert.ok(step <= bound, `seed ${seed}: ${step} decisions without ending (bound ${bound})`);
			const decision = decide(previous);
			assert.deepEqual(decide(previous), decision, `seed ${seed} step ${step}: same request, different decision`);

			if (decision.action === "stop") {
				if (!previous) {
					assert.equal(universe.length, 0, `seed ${seed}: stopped before the first route with routes available`);
				} else {
					const kind = classifyRouteAttempt(previous, PATTERNS);
					if (TRANSIENT_KINDS.includes(kind)) {
						assert.ok(
							sameRouteTransientFailures(previous.model) > maxSameRouteTransientRetries,
							`seed ${seed} step ${step}: stopped while the same-route transient budget remained`,
						);
					}
					if (!["success", "aborted", "context_overflow", "unhandled"].includes(kind)) {
						assert.ok(
							universe.every((route) => attempts.some((a) => sameRoute(a.model, route))),
							`seed ${seed} step ${step}: stopped after ${kind} with untried routes left`,
						);
					}
				}
				break;
			}

			const target = decision.model;
			assert.ok(universe.some((route) => sameRoute(route, target)), `seed ${seed} step ${step}: routed outside the candidate set`);
			const tried = attempts.filter((a) => sameRoute(a.model, target));
			if (tried.length === 0) {
				if (!previous) {
					assert.ok(sameRoute(universe[0]!, target), `seed ${seed}: the first route is not the first candidate`);
				} else {
					const kind = classifyRouteAttempt(previous, PATTERNS);
					if (TRANSIENT_KINDS.includes(kind) && sameRouteTransientFailures(previous.model) <= maxSameRouteTransientRetries) {
						assert.fail(`seed ${seed} step ${step}: moved away while the same-route transient budget remained`);
					}
				}
				assert.equal(decision.delayMs, undefined, `seed ${seed}: a fallback route carries a retry delay`);
			} else {
				assert.ok(previous && sameRoute(previous.model, target), `seed ${seed} step ${step}: re-routed to ${target.provider} without a failure on it`);
				assert.ok(TRANSIENT_KINDS.includes(classifyRouteAttempt(previous, PATTERNS)), `seed ${seed} step ${step}: retried a non-transient failure`);
				assert.ok(sameRouteTransientFailures(target) <= maxSameRouteTransientRetries, `seed ${seed}: retried beyond the budget`);
				assert.equal(decision.delayMs, previous.response?.retryAfterMs ?? TRANSIENT_DELAY_MS, `seed ${seed}: wrong retry delay`);
				assert.ok(!tried.some((a) => classifyRouteAttempt(a, PATTERNS) === "route_unavailable"), `seed ${seed}: routed to an unavailable route`);
			}

			const outcome = pick(next, OUTCOMES);
			previous = {
				operationId: "op",
				purpose: "memory/review",
				attempt: attempts.length + 1,
				model: target,
				dispatched: true,
				...outcome,
			};
			attempts.push(previous);
		}
	}
});
