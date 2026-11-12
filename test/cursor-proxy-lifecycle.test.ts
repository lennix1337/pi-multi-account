import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

// cursor/proxy.ts imports generated protobuf code that Node's type stripping cannot load in-process,
// so the listener lifecycle runs in a child that uses the repository TypeScript loader.
function runInProxyChild(body: string): string {
	return execFileSync(
		process.execPath,
		[
			"--import",
			new URL("./fixtures/typescript-loader.mjs", import.meta.url).href,
			"--input-type=module",
			"-e",
			`
		import assert from "node:assert/strict";
		import { getProxyPort, startProxy, stopProxy } from "./cursor/proxy.ts";
		import { ensureCursorProxy } from "./cursor/cursor-shared.ts";
		const token = async () => "test-token";
		${body}
	`,
		],
		{ cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 30_000 },
	);
}

test("concurrent startProxy calls share one listener instead of binding two", () => {
	const output = runInProxyChild(`
		const [first, second] = await Promise.all([startProxy(token), startProxy(token)]);
		assert.equal(second, first, "a start that is still binding must be joined, not repeated");
		assert.equal(getProxyPort(), first);
		assert.equal(await startProxy(token), first, "a started proxy is reused");
		stopProxy();
		assert.equal(getProxyPort(), undefined);
		console.log("ok");
	`);
	assert.match(output, /ok/);
});

test("stopProxy during a start releases the socket instead of publishing it", () => {
	const output = runInProxyChild(`
		const pending = startProxy(token);
		stopProxy();
		await assert.rejects(pending, /stopped while it was starting/);
		assert.equal(getProxyPort(), undefined, "a stopped proxy must not reappear when its bind completes");
		const port = await startProxy(token);
		assert.equal(getProxyPort(), port, "a later start works normally");
		stopProxy();
		console.log("ok");
	`);
	assert.match(output, /ok/);
});

test("a failed shared proxy start is not remembered for the rest of the process", () => {
	const output = runInProxyChild(`
		const resolver = async () => "test-token";
		const failing = ensureCursorProxy(resolver);
		stopProxy();
		await assert.rejects(failing, /stopped while it was starting/);
		const port = await ensureCursorProxy(resolver);
		assert.equal(getProxyPort(), port, "the next call starts a fresh proxy instead of replaying the rejection");
		stopProxy();
		console.log("ok");
	`);
	assert.match(output, /ok/);
});

// An embedded session (an OptChat worker, a subagent) ends with `quit` while the process lives on.
// Its listener is a GC root: left bound, it keeps that session's whole runtime in memory.
test("the last session to quit releases the proxy; one still using it keeps it", () => {
	const output = runInProxyChild(`
		const { registerSessionLifecycleCleanup } = await import("./cursor/index.ts");
		const session = () => {
			const handlers = new Map();
			const pi = { on: (name, handler) => handlers.set(name, handler) };
			registerSessionLifecycleCleanup(pi);
			return (reason) => handlers.get("session_shutdown")({ reason }, { sessionManager: { getSessionId: () => "s" } });
		};
		const port = await ensureCursorProxy(token);
		const endMain = session();
		const endWorker = session();
		endWorker("quit");
		assert.equal(getProxyPort(), port, "another session of this extension instance still serves through the proxy");
		endMain("quit");
		assert.equal(getProxyPort(), undefined, "the last session to quit must release the listener");
		console.log("ok");
	`);
	assert.match(output, /ok/);
});
