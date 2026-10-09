import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutateConfigFile } from "../config-file-transaction.ts";
import { replaceFileSync } from "../replace-file.ts";

// Another process (a second Pi session reading models.json, an antivirus scan) holds the target
// open for a moment. On Windows a bare rename over it fails with EPERM and the update is lost.
function holdOpen(path: string, ms: number): Promise<() => Promise<void>> {
	const child = spawn(process.execPath, [
		"-e",
		`const fs=require("fs");const fd=fs.openSync(${JSON.stringify(path)},"r");process.stdout.write("open\\n");setTimeout(()=>fs.closeSync(fd),${ms})`,
	]);
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.stdout.once("data", () => resolve(() => exited));
	});
}

test("a file replaced while another process reads it still lands", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pma-replace-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const target = join(dir, "models.json");
	writeFileSync(target, '{"old":true}\n');

	if (process.platform === "win32") {
		const done = await holdOpen(target, 200);
		writeFileSync(`${target}.bare`, '{"bare":true}\n');
		assert.throws(() => renameSync(`${target}.bare`, target), { code: "EPERM" }, "the Windows failure this guards against");
		await done();
	}

	const done = await holdOpen(target, 200);
	writeFileSync(`${target}.tmp`, '{"new":true}\n');
	replaceFileSync(`${target}.tmp`, target);
	await done();
	assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { new: true });
	assert.equal(existsSync(`${target}.tmp`), false);
});

test("a config patch that changes nothing leaves the file untouched", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pma-config-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const target = join(dir, "models.json");
	const original = '{\n  "providers": {}\n}\n';
	writeFileSync(target, original);

	assert.deepEqual(mutateConfigFile(target, () => undefined, undefined, 2), { providers: {} });
	assert.equal(readFileSync(target, "utf8"), original);

	mutateConfigFile(target, () => ({ providers: { a: { api: "x" } } }), undefined, 2);
	assert.equal(readFileSync(target, "utf8"), '{\n  "providers": {\n    "a": {\n      "api": "x"\n    }\n  }\n}\n');
});
