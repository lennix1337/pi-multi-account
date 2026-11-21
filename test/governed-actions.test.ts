import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts");

const ACTIONS =
	/\b(pi\.setModel|pi\.sendUserMessage|pi\.sendMessage|continueAgent|ctx\.compact)\s*\(/;

const FUNCTION = /^\t*(?:export\s+)?(?:async\s+)?function\s+(\w+)/;
const HOOK = /^\tsafeOn\(\s*"([^"]+)"/;

const ALLOWED: Record<string, string> = {
	resumeWithExistingContext: "gated by allowAction('resume the interrupted turn')",
	attemptQueuedInputResume: "gated by allowAction('send a held message')",
	"on:session_compact": "gated by allowAction('carry on after compaction')",
	"on:agent_settled": "gated by allowAction('ask for a summary')",
	"on:input": "preserves newer owner intent by queueing it as followUp",
	dispatchContextGuardContinuation:
		"gated by allowAction after the context-guard compaction completion callback",
	setModelEnsuringVisible: "only called by activateFallback, which is gated",
	injectContinuationPrompt:
		"only called from resumeWithExistingContext, which is gated — the fallback half of one gated action",
	attemptPendingResume:
		"restores the SAME account so the gated resume below it can run; not a rotation, and cannot loop without that gated resume",
};

const GATED = [
	"activateFallback",
	"resumeWithExistingContext",
	"attemptQueuedInputResume",
	"on:session_compact",
	"on:agent_settled",
];

function scopeBodies(): Map<string, string> {
	const lines = readFileSync(SOURCE, "utf8").split("\n");
	const bodies = new Map<string, string[]>();
	let scope: string | undefined;
	for (const line of lines) {
		const fn = FUNCTION.exec(line);
		const hook = HOOK.exec(line);
		if (fn) scope = fn[1];
		else if (hook) scope = `on:${hook[1]}`;
		if (!scope) continue;
		const body = bodies.get(scope) ?? [];
		body.push(line);
		bodies.set(scope, body);
	}
	return new Map([...bodies].map(([name, body]) => [name, body.join("\n")]));
}

function scan() {
	const lines = readFileSync(SOURCE, "utf8").split("\n");
	const sites: Array<{ line: number; scope: string; call: string; text: string }> = [];
	let scope = "<module>";
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const fn = FUNCTION.exec(line);
		if (fn) scope = fn[1];
		const hook = HOOK.exec(line);
		if (hook) scope = `on:${hook[1]}`;
		const trimmed = line.trim();
		if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("`"))
			continue;
		const call = ACTIONS.exec(line);
		if (call) sites.push({ line: i + 1, scope, call: call[1], text: trimmed.slice(0, 80) });
	}
	return sites;
}

test("nothing drives the session from outside the governed set", () => {
	const rogue = scan().filter((site) => !(site.scope in ALLOWED));
	assert.deepEqual(
		rogue.map((site) => `${site.call} at index.ts:${site.line} in ${site.scope}`),
		[],
		"a new place is driving the session. Route it through allowAction(), or add it to ALLOWED " +
			"in this file with the reason it cannot loop. Do not delete this assertion.",
	);
});

test("every allowed site still exists, so the list cannot rot into a rubber stamp", () => {
	const scopes = new Set(scan().map((site) => site.scope));
	const stale = Object.keys(ALLOWED).filter((name) => !scopes.has(name));
	assert.deepEqual(
		stale,
		[],
		"these names no longer drive the session; drop them from ALLOWED so the list keeps meaning something",
	);
});

test("every path that drives the session still asks the governor first", () => {
	const bodies = scopeBodies();
	const ungoverned = GATED.filter((name) => !(bodies.get(name) ?? "").includes("allowAction("));
	assert.deepEqual(
		ungoverned,
		[],
		"these no longer ask permission before acting, so nothing bounds them any more",
	);
});

test("the governor's own gate is still wired to every gated site", () => {
	const source = readFileSync(SOURCE, "utf8");
	assert.match(
		source,
		/function allowAction\([^)]*\)[^{]*\{\s*\n\s*if \(governorStopped\(\)\) return false;/,
		"allowAction must refuse once the governor has stopped the session",
	);
	const gated = source.match(/allowAction\(\s*"/g) ?? [];
	assert.ok(
		gated.length >= 5,
		`expected every driving path to ask the governor; found ${gated.length} call sites`,
	);
});
