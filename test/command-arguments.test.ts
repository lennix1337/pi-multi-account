import assert from "node:assert/strict";
import test from "node:test";

import { commandArgumentsProblem } from "../command-arguments.ts";
import { multiAccountCompletions } from "../command-completions.ts";

test("accepts bare input, documented aliases and optional arguments", () => {
	for (const input of [
		"", "  ", "status", "STATUS", "pins", "pins list", "pin codex/gpt-5", "unpin codex", "log", "logs 5", "debug 200", "log on",
		"log off", "models", "model", "add codex", "remove codex", "rm codex", "delete codex", "revive all", "accounts", "account refresh",
		"limits", "usage refresh", "quota", "switch codex", "use codex", "best", "live", "only-active", "focus on", "only-active off",
		"priority", "order reset", "priority anthropic openai-codex kimi-coding", "next", "stop", "enable", "disable", "clear", "reset",
		"reload", "rediscover", "pick", "save-default",
	]) assert.equal(commandArgumentsProblem(input), undefined, input);
});

test("rejects unknown subcommands with the valid names and no effect claim", () => {
	const message = commandArgumentsProblem("statu");
	assert.match(message ?? "", /unknown subcommand "statu"/);
	assert.match(message ?? "", /Nothing was changed/);
	assert.match(message ?? "", /Subcommands: status, pins, pin/);
	assert.match(commandArgumentsProblem("x".repeat(100)) ?? "", /"x{40}…"/);
});

test("rejects surplus or malformed arguments with the subcommand usage", () => {
	assert.equal(commandArgumentsProblem("reset now"), "pi-multi-account: usage: /multi-account reset");
	assert.equal(commandArgumentsProblem("pins list more"), "pi-multi-account: usage: /multi-account pins [list]");
	assert.match(commandArgumentsProblem("switch a b") ?? "", /usage: \/multi-account switch <provider>/);
	assert.match(commandArgumentsProblem("limits now") ?? "", /usage: \/multi-account limits \[refresh\]/);
	assert.match(commandArgumentsProblem("focus maybe") ?? "", /usage: \/multi-account only-active \[on\|off\]/);
});

test("log accepts only on, off or an integer from 1 to 200", () => {
	for (const input of ["log 1", "log 200", "log 040", "log on", "log off"]) assert.equal(commandArgumentsProblem(input), undefined, input);
	for (const input of ["log 0", "log 201", "log -1", "log 1.5", "log 1e2", "log +5", "log 40abc", "log 1000", "log ON", "log 5 6"]) {
		assert.match(commandArgumentsProblem(input) ?? "", /usage: \/multi-account log \[N\|on\|off\]/, input);
	}
});

test("every primary subcommand offered by completion is accepted", () => {
	const offered = multiAccountCompletions("", () => []) ?? [];
	assert.ok(offered.length > 0);
	for (const item of offered) assert.equal(commandArgumentsProblem(item.label), undefined, item.label);
});
