import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";


const read = (relative: string) =>
	readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const indexSource = read("../index.ts");
const workflow = read("../.github/workflows/claude-code-version-check.yml");

const WORKFLOW_GREP = `grep -oE 'CLAUDE_CODE_VERSION = "[^"]+"' index.ts`;
const EXTRACT = /CLAUDE_CODE_VERSION = "([^"]+)"/g;

test("the version-check workflow can still find the constant it is supposed to edit", () => {
	assert.ok(
		workflow.includes(WORKFLOW_GREP),
		"the workflow no longer greps with the pattern this test verifies — update both together",
	);

	const matches = [...indexSource.matchAll(EXTRACT)];
	assert.equal(
		matches.length,
		1,
		`expected exactly one CLAUDE_CODE_VERSION assignment in index.ts, found ${matches.length}: ` +
			"the workflow's grep|sed would extract the wrong one (or nothing) and no-op forever",
	);
	assert.match(
		matches[0]![1]!,
		/^\d+\.\d+\.\d+$/,
		"CLAUDE_CODE_VERSION must be a plain x.y.z release string",
	);
});

test("the maintainer bump can unambiguously rewrite the constant", () => {
	const bumped = indexSource.replace(
		/CLAUDE_CODE_VERSION = "[^"]+"/,
		'CLAUDE_CODE_VERSION = "99.99.99"',
	);
	assert.notEqual(bumped, indexSource, "the substitution matched nothing");
	assert.ok(bumped.includes('const CLAUDE_CODE_VERSION = "99.99.99";'));
});

test("the bumped constant is the one that ships in the OAuth billing header", () => {
	assert.ok(
		indexSource.includes("cc_version=${CLAUDE_CODE_VERSION}"),
		"CLAUDE_CODE_VERSION is no longer used to build the billing header",
	);
});

test("the version check never again depends on GitHub Actions opening a pull request", () => {
	const executable = workflow
		.split("\n")
		.filter((line) => !/^\s*#/.test(line))
		.join("\n");

	assert.ok(
		!/gh pr create/.test(executable),
		"this repo forbids Actions from creating PRs — that call fails every run and strands a branch",
	);
	assert.ok(!executable.includes("git push"), "version checks must respect protected main");
	assert.ok(/gh issue create/.test(executable), "new drift needs an actionable tracker");
	assert.ok(/gh issue edit/.test(executable), "recurring drift must update the existing tracker");
	assert.ok(/gh issue list/.test(executable), "look for an existing tracker before creating one");
});
