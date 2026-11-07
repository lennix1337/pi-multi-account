import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const mutants = [
	["slot-name", 'if (!slotId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slotId))', "if (false)", "anything that is not a slot route"],
	["path-traversal", 'if (rest.includes("..") || rest.includes("%2e%2e") || rest.includes("%2E%2E"))', "if (false)", "a path trying to climb"],
	["published-slot", 'if (!route) return { ok: false, status: 404, message: "unknown slot" };', "", "a slot we never published"],
	["caller-credential", "if (!accepted) {", "if (false) {", "a caller that does not present"],
	["api-throttle", "const temporaryApiThrottle = !managed && isTemporaryApiThrottle(errorText);", "const temporaryApiThrottle = false;", "structured API throttling retains", "index.ts", "failover.test.ts"],
	["ladder-above-liveness", "Number(right.confirmed) - Number(left.confirmed) ||\n\t\tNumber(left.predictedBusy) - Number(right.predictedBusy) ||\n\t\tcomparePriority(left.group, right.group, options.providerPriority) ||", "comparePriority(left.group, right.group, options.providerPriority) ||\n\t\tNumber(right.confirmed) - Number(left.confirmed) ||\n\t\tNumber(left.predictedBusy) - Number(right.predictedBusy) ||", "failover serves exactly", "completion-route-planner.ts", "completion-route-properties.test.ts"],
	["free-accounts-only", "if (available.length > 0) return available.map((candidate) => candidate.model);", "if (available.length > 0) return scored.map((candidate) => candidate.model);", "failover serves exactly", "completion-route-planner.ts", "completion-route-properties.test.ts"],
	["available-now-only", "if (options.availableNowOnly) return [];", "if (false) return [];", "failover serves exactly", "completion-route-planner.ts", "completion-route-properties.test.ts"],
	["anti-ping-pong-off", "options.now - options.lastLeftAt < options.antiPingPongMs &&", "false &&", "anti-ping-pong", "completion-route-planner.ts", "completion-route-properties.test.ts"],
	["same-model-not-preferred", "? Number(right.sameModel) - Number(left.sameModel) || Number(right.sameFamily) - Number(left.sameFamily)", "? Number(right.sameFamily) - Number(left.sameFamily)", "same-model accounts lead", "completion-route-planner.ts", "completion-route-properties.test.ts"],
	["recovery-soonest-last", ".sort((left, right) => left.remaining - right.remaining || byPolicy(left, right))", ".sort((left, right) => right.remaining - left.remaining || byPolicy(left, right))", "cooldown expiry over time", "completion-route-planner.ts", "completion-route-properties.test.ts"],
	["ignored-text-not-honoured", "if (text && matches(text, patterns.ignore)) return \"unhandled\";", "if (false) return \"unhandled\";", "failure classification follows", "completion-route-planner.ts", "completion-route-properties.test.ts"],
	["unauthorized-status-ignored", "if (attempt.response?.status === 401 || matches(text, patterns.auth)) return \"auth\";", "if (matches(text, patterns.auth)) return \"auth\";", "classification pins", "completion-route-planner.ts", "completion-route-properties.test.ts"],
	["same-route-budget-off-by-one", "if (sameRouteTransientFailures <= options.maxSameRouteTransientRetries) {", "if (sameRouteTransientFailures < options.maxSameRouteTransientRetries) {", "an operation's route sequence", "completion-route-planner.ts", "completion-route-properties.test.ts"],
	["unbounded-same-route-retry", "if (sameRouteTransientFailures <= options.maxSameRouteTransientRetries) {", "if (true) {", "an operation's route sequence", "completion-route-planner.ts", "completion-route-properties.test.ts"],
	["unavailable-route-reused", "const attempted = new Set(request.attempts.map((attempt) => routeKey(attempt.model)));", "const attempted = new Set(request.attempts.filter((attempt) => attempt.stopReason !== \"route_unavailable\").map((attempt) => routeKey(attempt.model)));", "an operation's route sequence", "completion-route-planner.ts", "completion-route-properties.test.ts"],
	["api-key-anthropic-refused", "credential === \"oauth\" && /^anthropic", "/^anthropic", "API-key slot is always usable", "child-usability.ts", "child-usability-properties.test.ts"],
	["loopback-prefix-match", "hostname === \"127.0.0.1\" ||", "hostname.startsWith(\"127.\") ||", "parent-proxy route exists only", "child-usability.ts", "child-usability-properties.test.ts"],
	["oauth-placeholder-usable", "  if (credential === \"oauth\") {", "  if (credential === \"oauth\" && publishedApiKey && isLoopback(publishedBaseUrl)) return { usable: true, slotId, via: \"parent-proxy\", note: \"mutant\" };\n  if (credential === \"oauth\") {", "OAuth token under its key", "child-usability.ts", "child-usability-properties.test.ts"],
];

for (const [name, before, after, pattern, sourceFile = "slot-proxy.ts", testFile = "slot-proxy.test.ts"] of mutants) {
	const dir = mkdtempSync(join(tmpdir(), "pmacct-mutant-"));
	try {
		for (const file of readdirSync(root).filter((file) => file.endsWith(".ts") || file === "package.json")) {
			cpSync(join(root, file), join(dir, file));
		}
		cpSync(join(root, "test", testFile), join(dir, "test", testFile), { recursive: true });
		symlinkSync(resolve(root, "node_modules"), join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
		const path = join(dir, sourceFile);
		const source = readFileSync(path, "utf8");
		assert.equal(source.split(before).length, 2, `${name}: mutation must be unique`);
		writeFileSync(path, source.replace(before, after));
		const result = spawnSync(process.execPath, ["--test", `--test-name-pattern=${pattern}`, `test/${testFile}`], { cwd: dir, encoding: "utf8", timeout: 30000 });
		assert.equal(result.error, undefined, `${name}: test process must complete`);
		assert.notEqual(result.status, 0, `${name}: mutant survived`);
		assert.match(result.stdout + result.stderr, /AssertionError/, `${name}: must fail an assertion, not crash`);
		console.log(`${name}: killed by assertion`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
console.log(`${mutants.length}/${mutants.length} guard mutants killed; disposable copies only`);
