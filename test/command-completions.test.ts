import assert from "node:assert/strict";
import test from "node:test";
import { type AccountChoice, multiAccountCompletions } from "../command-completions.ts";

const accounts: AccountChoice[] = [
	{ provider: "openai-codex", status: "cooldown 2h", ready: false, current: false, account: "me@home.dev" },
	{ provider: "anthropic", status: "ready", ready: true, current: true, account: "me@home.dev" },
	{ provider: "openai-codex-account-2", status: "ready", ready: true, current: false, account: "me@work.dev", usage: "5h 80%" },
	{ provider: "cursor", status: "unavailable · no credential", ready: false, current: false },
];
const list = () => accounts;

test("an empty argument lists every subcommand", () => {
	const items = multiAccountCompletions("", list);
	assert.ok(items && items.length > 20);
	assert.ok(items.some((item) => item.label === "use" && item.value === "use "));
});

test("a partial subcommand narrows the list and never lists accounts", () => {
	let listed = false;
	const items = multiAccountCompletions("re", () => {
		listed = true;
		return accounts;
	});
	assert.deepEqual(
		items?.map((item) => item.label),
		["rediscover", "remove", "revive", "reset", "reload"],
	);
	assert.equal(listed, false);
});

test("use with no account yet lists ready accounts first and the current one last", () => {
	const items = multiAccountCompletions("use ", list);
	assert.deepEqual(items?.map((item) => item.label), [
		"openai-codex-account-2",
		"openai-codex",
		"cursor",
		"anthropic",
	]);
	assert.equal(items?.[0].value, "use openai-codex-account-2");
	assert.equal(items?.[0].description, "me@work.dev · ready · 5h 80%");
	assert.match(items?.[3].description ?? "", /^me@home\.dev · current · ready$/);
});

test("typing filters by provider id or account identity, case-insensitively", () => {
	assert.deepEqual(multiAccountCompletions("switch CODEX", list)?.map((item) => item.value), [
		"switch openai-codex-account-2",
		"switch openai-codex",
	]);
	assert.deepEqual(multiAccountCompletions("use work", list)?.map((item) => item.label), [
		"openai-codex-account-2",
	]);
});

test("no completion when nothing matches, past the account, or for other subcommands", () => {
	assert.equal(multiAccountCompletions("use zzz", list), null);
	assert.equal(multiAccountCompletions("use anthropic extra", list), null);
	assert.equal(multiAccountCompletions("next ", list), null);
	assert.equal(multiAccountCompletions("bogus", list), null);
});
