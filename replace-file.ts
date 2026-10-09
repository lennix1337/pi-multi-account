/** Atomic temp-file publication that survives Windows' transient sharing violations. */
import { renameSync } from "node:fs";

const pause = new Int32Array(new SharedArrayBuffer(4));
// Windows refuses to replace a file while any process (another Pi session reading models.json,
// an antivirus or indexer scan) holds it open, and reports EPERM/EACCES/EBUSY. The holder lets go
// within milliseconds, so retry briefly — bounded, because every caller runs on Pi's event loop.
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);
const RETRY_BUDGET_MS = 1000;

export function replaceFileSync(temp: string, target: string): void {
	const deadline = Date.now() + RETRY_BUDGET_MS;
	for (let delay = 10; ; delay = Math.min(delay * 2, 100)) {
		try {
			renameSync(temp, target);
			return;
		} catch (error: any) {
			if (process.platform !== "win32" || !TRANSIENT.has(error?.code) || Date.now() >= deadline) throw error;
			Atomics.wait(pause, 0, 0, delay);
		}
	}
}
