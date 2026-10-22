/**
 * Contract of the Cursor OAuth `login` that `registerCursorProvider` hands to Pi for every
 * numbered account slot: show the sign-in URL, wait for the tokens, refuse a duplicate account
 * BEFORE the catalog is read, and never fail a login because the catalog could not be read.
 *
 * Hermetic, and each scenario runs in its own child process because the generated protobuf
 * needs the TypeScript loader (like the other Cursor tests) and `getCursorModels` caches a
 * successful catalog for the life of the process. Inside the child:
 *   - `fetch` is a fail-closed stub: it answers only the Cursor poll URL, and every other
 *     request, plus any socket connect, is recorded and rejected. The child fails if it saw one.
 *   - the catalog goes through the proxy's bridge factory, replaced by an in-memory fake, so no
 *     helper process or Cursor endpoint is involved.
 *   - waits of up to 10s (the poll back-off) run immediately; the catalog RPC's own 20s timeout is untouched.
 * No browser, credential file or real account is touched.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOADER = new URL("./fixtures/typescript-loader.mjs", import.meta.url).href;

const PRELUDE = `
	import assert from "node:assert/strict";
	import net from "node:net";
	import { create, toBinary } from "@bufbuild/protobuf";
	import { GetUsableModelsResponseSchema } from "./cursor/proto/agent_pb.ts";
	import { registerCursorProvider } from "./cursor/cursor-shared.ts";
	import { setBridgeFactoryForTests } from "./cursor/proxy.ts";

	const SLOT = "cursor-account-2";
	const ACCESS = "header." + Buffer.from(JSON.stringify({ exp: 4000000000 })).toString("base64url") + ".signature";
	const REFRESH = "refresh-token-fixture";
	const blocked = [];
	const pollUrls = [];
	const catalogCalls = [];
	let pollResponses = [];
	let catalogResponse = { exitCode: 1, body: new Uint8Array() };

	globalThis.fetch = async (input) => {
		const url = String(typeof input === "object" && "url" in input ? input.url : input);
		if (!url.startsWith("https://api2.cursor.sh/auth/poll?")) {
			blocked.push("fetch " + url);
			throw new Error("outbound request blocked by the test");
		}
		pollUrls.push(url);
		const next = pollResponses.shift();
		if (!next) throw new Error("unexpected extra poll");
		return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status });
	};
	net.Socket.prototype.connect = function () {
		blocked.push("socket connect");
		throw new Error("outbound socket blocked by the test");
	};
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = (callback, delay, ...rest) => realSetTimeout(callback, delay <= 10000 ? 0 : delay, ...rest);
	console.warn = () => {};
	console.error = () => {};

	setBridgeFactoryForTests((options) => {
		catalogCalls.push(options.rpcPath + " token=" + options.accessToken);
		let onData;
		let onClose;
		return {
			proc: { kill() {} },
			alive: true,
			write() {},
			destroy() {},
			onData(callback) { onData = callback; },
			onClose(callback) { onClose = callback; },
			// Answering synchronously on end clears the RPC's own timeout before it can fire.
			end() {
				if (catalogResponse.body.length > 0) onData?.(Buffer.from(catalogResponse.body));
				onClose?.(catalogResponse.exitCode);
			},
		};
	});

	function loginOf(options) {
		let config;
		registerCursorProvider({ registerProvider: (_id, cfg) => { config = cfg; } }, SLOT, 1, undefined, options);
		assert.ok(config, "the slot registers an oauth login");
		return config.oauth.login;
	}
	function authenticate(sequence) {
		return { onAuth: (info) => sequence.push("onAuth " + info.url) };
	}
	function finish() {
		assert.deepEqual(blocked, [], "nothing outside the poll endpoint may be attempted");
	}
`;

/** Runs one scenario body in a child that has the hermetic prelude; throws with the child's output on failure. */
function runScenario(body: string): void {
	execFileSync(process.execPath, ["--import", LOADER, "--input-type=module", "-e", `${PRELUDE}\n${body}\nfinish();`], {
		cwd: REPO_ROOT,
		// A scrubbed environment: the login code has no business reading anything from the caller's.
		env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 60_000,
	});
}

test("a duplicate account is rejected before the catalog is read, so nothing is discovered", () => {
	runScenario(`
		pollResponses = [{ status: 404 }, { status: 200, body: { accessToken: ACCESS, refreshToken: REFRESH } }];
		const discovered = [];
		const rejected = [];
		const login = loginOf({
			rejectDuplicateLogin: (slot, credentials) => {
				rejected.push([slot, { ...credentials }]);
				throw new Error('This real account is already logged in as "cursor".');
			},
			onModelsDiscovered: (models) => discovered.push(models),
		});

		await assert.rejects(login(authenticate([])), /already logged in as "cursor"/);

		assert.equal(rejected.length, 1);
		assert.equal(rejected[0][0], SLOT, "the guard is told which slot is logging in");
		assert.equal(rejected[0][1].access, ACCESS);
		assert.equal(rejected[0][1].refresh, REFRESH);
		assert.deepEqual(catalogCalls, [], "the catalog must not be requested for a refused duplicate");
		assert.deepEqual(discovered, []);
	`);
});

test("an unreadable catalog never fails a login that already has valid credentials", () => {
	runScenario(`
		pollResponses = [{ status: 200, body: { accessToken: ACCESS, refreshToken: REFRESH } }];
		const discovered = [];
		const login = loginOf({ onModelsDiscovered: (models) => discovered.push(models) });

		const credentials = await login(authenticate([]));

		assert.equal(credentials.access, ACCESS);
		assert.equal(catalogCalls.length, 1, "the catalog was attempted once");
		assert.deepEqual(discovered, [], "a failed catalog read reports no models");
	`);
});

test("polling failure rejects the login without checking duplicates or reading the catalog", () => {
	runScenario(`
		pollResponses = [{ status: 500 }, { status: 500 }, { status: 500 }];
		let duplicateChecks = 0;
		const sequence = [];
		const login = loginOf({
			rejectDuplicateLogin: (_slot, credentials) => { duplicateChecks++; return credentials; },
			onModelsDiscovered: () => sequence.push("discovered"),
		});

		await assert.rejects(login(authenticate(sequence)), /Too many consecutive errors during Cursor auth polling/);

		assert.match(sequence[0], /^onAuth https:\\/\\/cursor\\.com\\/loginDeepControl\\?/, "the user was shown the sign-in URL first");
		assert.equal(sequence.length, 1, "nothing is discovered after a failed poll");
		assert.equal(duplicateChecks, 0);
		assert.deepEqual(catalogCalls, []);
		assert.equal(pollUrls.length, 3);
	`);
});

test("login shows the URL, polls with the matching uuid and verifier, then verifies and reads the catalog", () => {
	runScenario(`
		pollResponses = [{ status: 404 }, { status: 200, body: { accessToken: ACCESS, refreshToken: REFRESH } }];
		catalogResponse = {
			exitCode: 0,
			body: toBinary(GetUsableModelsResponseSchema, create(GetUsableModelsResponseSchema, {
				models: [{ modelId: "fixture-model", displayName: "Fixture Model" }],
			})),
		};
		const sequence = [];
		const verified = { type: "oauth", access: ACCESS, refresh: REFRESH, expires: 1, marker: "from-guard" };
		const login = loginOf({
			rejectDuplicateLogin: (slot, credentials) => { sequence.push("verify " + slot + " " + credentials.access); return verified; },
			onModelsDiscovered: (models) => sequence.push("discovered " + models.map((model) => model.id).join(",")),
		});

		const credentials = await login(authenticate(sequence));

		assert.equal(credentials, verified, "the credentials stored are the ones the duplicate guard returned");
		assert.equal(sequence.length, 3);
		assert.match(sequence[0], /^onAuth https:\\/\\/cursor\\.com\\/loginDeepControl\\?/);
		assert.equal(sequence[1], "verify " + SLOT + " " + ACCESS);
		assert.equal(sequence[2], "discovered fixture-model");
		assert.deepEqual(catalogCalls, ["/agent.v1.AgentService/GetUsableModels token=" + ACCESS]);

		const signIn = new URL(sequence[0].slice("onAuth ".length));
		const uuid = signIn.searchParams.get("uuid");
		assert.ok(uuid && signIn.searchParams.get("challenge"), "the sign-in URL carries the PKCE challenge and uuid");
		assert.equal(pollUrls.length, 2, "a 404 only means the user has not finished signing in yet");
		for (const url of pollUrls) {
			const poll = new URL(url);
			assert.equal(poll.searchParams.get("uuid"), uuid);
			assert.ok(poll.searchParams.get("verifier"), "the poll proves possession with the PKCE verifier");
		}
	`);
});

test("without a duplicate guard the polled credentials are returned as an oauth entry", () => {
	runScenario(`
		pollResponses = [{ status: 200, body: { accessToken: ACCESS, refreshToken: REFRESH } }];
		const credentials = await loginOf({})(authenticate([]));

		assert.deepEqual(credentials, {
			type: "oauth",
			access: ACCESS,
			refresh: REFRESH,
			expires: 4000000000 * 1000 - 5 * 60 * 1000,
		});
		assert.deepEqual(catalogCalls, [], "no catalog listener means no catalog request");
	`);
});
