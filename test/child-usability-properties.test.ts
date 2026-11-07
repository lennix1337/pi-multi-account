/**
 * Seeded property checks for subagent account inheritance (child-usability.ts).
 *
 * The oracle is the matrix documented at the top of the module: which slot shapes a bare child can
 * run on, and which loopback route makes an Anthropic subscription usable. A failing case prints
 * its seed; the same seed replays the exact facts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	classifyChildUsability,
	defaultRouteWarning,
	describeChildUsability,
	type ChildUsability,
	type SlotChildFacts,
} from "../child-usability.ts";

const CASES = 200;

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

const SLOTS = [
	"anthropic",
	"anthropic-account-2",
	"openai-codex",
	"openai-codex-account-4",
	"kimi-coding-account-2",
	"cursor-account-2",
	"zai",
	"qwen",
];
const BASE_URLS: Array<string | undefined> = [
	undefined,
	"http://127.0.0.1:4141",
	"http://localhost:8080/v1",
	"http://[::1]:9000",
	"http://127.0.0.1.evil.example",
	"http://localhost.evil.example:80",
	"https://api.anthropic.com",
	"http://10.0.0.5:4141",
	"not a url",
];

function genFacts(seed: number): SlotChildFacts {
	const next = rng(seed);
	return {
		slotId: pick(next, SLOTS),
		credential: pick(next, ["oauth", "api_key", "none"] as const),
		builtin: next() < 0.5,
		publishedApiKey: next() < 0.5 ? "non-secret-placeholder" : undefined,
		publishedBaseUrl: pick(next, BASE_URLS),
	};
}

/** Loopback by the WHATWG host of the URL, exact match. */
function isLoopbackUrl(url: string | undefined): boolean {
	if (url === undefined) return false;
	let host: string;
	try {
		host = new URL(url).hostname;
	} catch {
		return false;
	}
	return ["127.0.0.1", "localhost", "[::1]"].includes(host);
}

const isAnthropicFamily = (slotId: string) => /^anthropic(?:-account-\d+)?$/.test(slotId);
const USABLE_VIA = ["builtin", "api-key", "parent-proxy"];

test("every verdict is either usable with a route and a note, or refused with a reason and a remedy", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const facts = genFacts(seed);
		const verdict: ChildUsability = classifyChildUsability(facts);
		assert.equal(verdict.slotId, facts.slotId, `seed ${seed}`);
		if (verdict.usable) {
			assert.ok(USABLE_VIA.includes(verdict.via), `seed ${seed}: unknown route ${verdict.via}`);
			assert.ok(verdict.note.length > 0, `seed ${seed}: usable without a note`);
		} else {
			assert.ok(verdict.reason.length > 0 && verdict.remedy.length > 0, `seed ${seed}: refusal without reason or remedy`);
		}
	}
});

test("a parent-proxy route exists only on a loopback base URL, never on a remote or look-alike host", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const facts = genFacts(seed);
		const verdict = classifyChildUsability(facts);
		if (verdict.usable && verdict.via === "parent-proxy") {
			assert.ok(isLoopbackUrl(facts.publishedBaseUrl), `seed ${seed}: parent-proxy on ${facts.publishedBaseUrl}`);
		}
		if (!isLoopbackUrl(facts.publishedBaseUrl)) {
			assert.ok(!(verdict.usable && verdict.via === "parent-proxy"), `seed ${seed}: non-loopback route granted`);
		}
	}
});

test("a models.json slot with an OAuth token under its key is never usable: Pi never consults that token there", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const facts = genFacts(seed);
		if (facts.credential !== "oauth" || facts.builtin) continue;
		assert.equal(classifyChildUsability(facts).usable, false, `seed ${seed}: ${JSON.stringify(facts)}`);
	}
});

test("an API-key slot is always usable, through the store or a loopback placeholder, never refused", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const facts = genFacts(seed);
		if (facts.credential !== "api_key") continue;
		const verdict = classifyChildUsability(facts);
		assert.equal(verdict.usable, true, `seed ${seed}: ${JSON.stringify(facts)}`);
		if (verdict.usable && verdict.via === "parent-proxy") {
			assert.ok(facts.publishedApiKey !== undefined && isLoopbackUrl(facts.publishedBaseUrl), `seed ${seed}: placeholder route without a loopback`);
		}
	}
});

test("the subscription Anthropic family needs its loopback proxy: built-in OAuth is refused as a third-party app unless the parent shapes the request", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const facts = genFacts(seed);
		if (facts.credential !== "oauth" || !facts.builtin || !isAnthropicFamily(facts.slotId)) continue;
		const verdict = classifyChildUsability(facts);
		if (isLoopbackUrl(facts.publishedBaseUrl)) {
			assert.ok(verdict.usable && verdict.via === "parent-proxy", `seed ${seed}: loopback route not granted`);
		} else {
			assert.equal(verdict.usable, false, `seed ${seed}: refused family granted without loopback`);
		}
	}
});

test("a built-in provider with a vendor-served credential is usable through Pi's own flow, whatever the published URL", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const facts = genFacts(seed);
		if (!facts.builtin || facts.credential === "none") continue;
		if (facts.credential === "oauth" && isAnthropicFamily(facts.slotId)) continue;
		const verdict = classifyChildUsability(facts);
		assert.ok(verdict.usable && verdict.via === "builtin", `seed ${seed}: ${JSON.stringify(facts)}`);
	}
});

test("the route label is honest: api-key only for a non-built-in credential-store key", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const facts = genFacts(seed);
		const verdict = classifyChildUsability(facts);
		if (verdict.usable && verdict.via === "api-key") {
			assert.equal(facts.credential, "api_key", `seed ${seed}`);
			assert.equal(facts.builtin, false, `seed ${seed}`);
		}
	}
});

test("the status listing has one line per slot, refused slots first, each group ordered by slot id, whatever the input order", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const next = rng(seed);
		const verdicts = Array.from({ length: 1 + Math.floor(next() * 8) }, (_, i) =>
			classifyChildUsability({ ...genFacts(seed * 31 + i), slotId: `${SLOTS[i % SLOTS.length]}-n${i}` }),
		);
		const lines = describeChildUsability(verdicts);
		assert.equal(lines.length, verdicts.length, `seed ${seed}: one line per slot`);
		const refused = lines.map((line) => line.includes("NOT usable"));
		const firstUsable = refused.indexOf(false);
		if (firstUsable >= 0) assert.ok(refused.slice(firstUsable).every((r) => !r), `seed ${seed}: a refused slot listed after a usable one`);
		const groupOf = (flag: boolean) => lines.filter((_, i) => refused[i] === flag).map((line) => line.trim().split(" ")[0]!);
		for (const flag of [true, false]) {
			const ids = groupOf(flag);
			assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)), `seed ${seed}: slot ids out of order`);
		}
		const reversed = describeChildUsability([...verdicts].reverse());
		assert.deepEqual(reversed, lines, `seed ${seed}: input order changed the listing`);
	}
});

test("the default-route warning names the saved slot only when that slot is not child-usable", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const facts = genFacts(seed);
		const verdict = classifyChildUsability(facts);
		const warning = defaultRouteWarning(facts.slotId, () => verdict);
		if (verdict.usable) assert.equal(warning, undefined, `seed ${seed}: warned about a usable default`);
		else assert.ok(warning?.includes(facts.slotId) && warning.includes(verdict.reason), `seed ${seed}: warning missing the slot or reason`);
	}
	assert.equal(defaultRouteWarning(undefined, () => undefined), undefined);
});
