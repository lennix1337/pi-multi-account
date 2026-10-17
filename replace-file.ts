/** Atomic temp-file publication that survives Windows' transient sharing violations. */
import { renameSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const pause = new Int32Array(new SharedArrayBuffer(4));
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);
const RETRY_BUDGET_MS = 1000;

function tryReplaceFile(temp: string, target: string, deadline: number): boolean {
	try {
		renameSync(temp, target);
		return true;
	} catch (error: any) {
		if (process.platform !== "win32" || !TRANSIENT.has(error?.code) || Date.now() >= deadline) throw error;
		return false;
	}
}

// Async readers in this process need the event loop to close their Windows handles.
export async function replaceFile(temp: string, target: string, canCommit: () => boolean): Promise<void> {
	const deadline = Date.now() + RETRY_BUDGET_MS;
	for (let delay = 10; ; delay = Math.min(delay * 2, 100)) {
		if (!canCommit()) throw new Error("session changed before config persistence");
		if (tryReplaceFile(temp, target, deadline)) return;
		await sleep(delay);
	}
}

// Kept for synchronous auth/state callers; startup model publication uses replaceFile.
export function replaceFileSync(temp: string, target: string): void {
	const deadline = Date.now() + RETRY_BUDGET_MS;
	for (let delay = 10; !tryReplaceFile(temp, target, deadline); delay = Math.min(delay * 2, 100)) {
		Atomics.wait(pause, 0, 0, delay);
	}
}
