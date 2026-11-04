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
];

for (const [name, before, after, pattern] of mutants) {
	const dir = mkdtempSync(join(tmpdir(), "pmacct-mutant-"));
	try {
		for (const file of readdirSync(root).filter((file) => file.endsWith(".ts") || file === "package.json")) {
			cpSync(join(root, file), join(dir, file));
		}
		cpSync(join(root, "test", "slot-proxy.test.ts"), join(dir, "test", "slot-proxy.test.ts"), { recursive: true });
		symlinkSync(resolve(root, "node_modules"), join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
		const path = join(dir, "slot-proxy.ts");
		const source = readFileSync(path, "utf8");
		assert.equal(source.split(before).length, 2, `${name}: mutation must be unique`);
		writeFileSync(path, source.replace(before, after));
		const result = spawnSync(process.execPath, ["--test", `--test-name-pattern=${pattern}`, "test/slot-proxy.test.ts"], { cwd: dir, encoding: "utf8", timeout: 30000 });
		assert.equal(result.error, undefined, `${name}: test process must complete`);
		assert.notEqual(result.status, 0, `${name}: mutant survived`);
		assert.match(result.stdout + result.stderr, /AssertionError/, `${name}: must fail an assertion, not crash`);
		console.log(`${name}: killed by assertion`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
console.log(`${mutants.length}/${mutants.length} guard mutants killed; disposable copies only`);
