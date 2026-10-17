/** Shared read-latest/field-scoped transaction for every extension config writer. */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { replaceFile, replaceFileSync } from "./replace-file.ts";

const require = createRequire(import.meta.url);
const pause = new Int32Array(new SharedArrayBuffer(4));
type ConfigPatch = (disk: Record<string, any>) => Record<string, unknown> | undefined;

function stageConfigUpdate(target: string, temp: string, patch: ConfigPatch, canCommit: () => boolean, indent: string | number) {
	if (!canCommit()) throw new Error("session changed before config persistence");
	const disk = JSON.parse(readFileSync(target, "utf8"));
	if (!disk || typeof disk !== "object" || Array.isArray(disk)) throw new Error("config must be an object");
	const delta = patch(disk);
	if (delta === undefined) return { value: disk, changed: false };
	if (!delta || typeof delta !== "object" || Array.isArray(delta)) throw new Error("config patch must be an object");
	const next = { ...disk, ...delta };
	if (!canCommit()) throw new Error("session changed before config persistence");
	writeFileSync(temp, `${JSON.stringify(next, null, indent)}\n`, { mode: 0o600, flag: "wx" });
	return { value: next, changed: true };
}

// Startup model publication must yield while Pi's async model refresh holds the file.
export async function mutateConfigFileAsync(
	path: string,
	patch: ConfigPatch,
	canCommit: () => boolean = () => true,
	indent: string | number = "\t",
): Promise<Record<string, any>> {
	const target = realpathSync(path);
	const lockfile = require("proper-lockfile") as { lock(path: string, options: object): Promise<() => Promise<void>> };
	const release = await lockfile.lock(target, { realpath: false, retries: { retries: 25, minTimeout: 10, maxTimeout: 10, factor: 1 } });
	const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
	try {
		const update = stageConfigUpdate(target, temp, patch, canCommit, indent);
		if (update.changed) await replaceFile(temp, target, canCommit);
		return update.value;
	} finally {
		try { rmSync(temp, { force: true }); } finally { await release(); }
	}
}

export function mutateConfigFile(
	path: string,
	// Return undefined when the file already holds the wanted value: nothing is rewritten.
	patch: ConfigPatch,
	canCommit: () => boolean = () => true,
	indent: string | number = "\t",
): Record<string, any> {
	// Preserve config symlinks and make aliases coordinate on the same target lock.
	const target = realpathSync(path);
	const lockfile = require("proper-lockfile") as { lockSync(path: string, options: object): () => void };
	let release: (() => void) | undefined;
	const deadline = Date.now() + 250;
	while (!release) {
		if (!canCommit()) throw new Error("session changed before config persistence");
		try { release = lockfile.lockSync(target, { realpath: false }); }
		catch (error: any) {
			if (error?.code !== "ELOCKED" || Date.now() >= deadline) throw error;
			Atomics.wait(pause, 0, 0, 5);
		}
	}
	const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
	try {
		const update = stageConfigUpdate(target, temp, patch, canCommit, indent);
		if (update.changed) {
			if (!canCommit()) throw new Error("session changed before config persistence");
			replaceFileSync(temp, target);
		}
		return update.value;
	} finally {
		try { rmSync(temp, { force: true }); } finally { release(); }
	}
}
