import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach, mock } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { anthropicLoginProvider, protectAnthropicLogin } from "../anthropic-login.ts";

beforeEach(() => { mock.method(globalThis, "fetch", async () => { throw new Error("login fixtures must stay offline"); }); });
afterEach(() => { mock.restoreAll(); });

const oauth = { type: "oauth" as const, access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 86_400_000 };
const apiKey = { type: "api_key" as const, key: "fixture-api-key" };

for (const initial of [oauth, apiKey]) {
	test(`native login keeps ${initial.type} and signs in with the other type in a separate slot`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "anthropic-login-"));
		const authPath = join(dir, "auth.json");
		try {
			writeFileSync(authPath, JSON.stringify({ anthropic: initial, unrelated: apiKey }));
			const read = () => JSON.parse(readFileSync(authPath, "utf8"));
			const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
			const native = builtinProviders().find((provider) => provider.id === "anthropic")!;
			const base = { ...native, auth: { ...native.auth, oauth: { ...native.auth.oauth!, login: async () => oauth } } };
			for (const id of ["anthropic", "anthropic-account-2"]) {
				runtime.registerNativeProvider(anthropicLoginProvider(base, id, (slot) => read()[slot]));
			}
			const type = initial.type === "oauth" ? "api_key" : "oauth";
			let prompts = 0;
			const interaction = {
				signal: new AbortController().signal,
				prompt: async (prompt: { type: string }) => { assert.equal(prompt.type, "secret"); prompts++; return apiKey.key; },
				notify: () => {},
			};
			await assert.rejects(runtime.login("anthropic", type, interaction), /It was not replaced.*free anthropic-account-N/);
			assert.equal(prompts, 0, "reject before asking for a secret");
			assert.deepEqual(read().anthropic, initial);
			await runtime.login("anthropic-account-2", type, interaction);
			assert.deepEqual(read().anthropic, initial);
			assert.deepEqual(read()["anthropic-account-2"], type === "oauth" ? oauth : apiKey);
			assert.deepEqual(read().unrelated, apiKey);
			for (const id of ["anthropic", "anthropic-account-2"]) {
				assert.ok((await runtime.getAvailable(id)).length > 0, `${id} must remain selectable`);
			}
			// Same-type re-login remains supported.
			await runtime.login("anthropic-account-2", type, interaction);
			assert.deepEqual(read().anthropic, initial);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}

test("numbered Anthropic catalogs retain slot identity on modern Pi hosts", () => {
	const native = builtinProviders().find((provider) => provider.id === "anthropic")!;
	const chat = native.getModels()[0];
	const all = () => [{ ...chat, id: "host-only-claude" }];
	const base = { ...native, getAllModels: all };
	const slot = anthropicLoginProvider(base, "anthropic-account-2", () => oauth) as typeof base;
	assert.ok(slot.getModels().every((model) => model.provider === slot.id));
	assert.deepEqual(slot.getAllModels(), [{ ...all()[0], provider: slot.id }]);
	assert.equal(base.getAllModels()[0].provider, "anthropic", "the base catalog must remain untouched");
});

test("an explicit slot catalog drives both modern and legacy model lookups", () => {
	const native = builtinProviders().find((provider) => provider.id === "anthropic")!;
	const base = { ...native, getAllModels: () => native.getModels() };
	const models = () => [{ ...native.getModels()[0], id: "host-only-claude" }];
	const slot = anthropicLoginProvider(base, "anthropic-account-2", () => oauth, models);
	assert.deepEqual(slot.getAllModels(), slot.getModels());
	assert.deepEqual(slot.getAllModels().map(({ id, provider }) => ({ id, provider })),
		[{ id: "host-only-claude", provider: "anthropic-account-2" }]);
});

test("the type guard is necessary: the native store otherwise replaces OAuth with an API key", async () => {
	const dir = mkdtempSync(join(tmpdir(), "anthropic-login-control-"));
	const authPath = join(dir, "auth.json");
	try {
		writeFileSync(authPath, JSON.stringify({ anthropic: oauth }));
		const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
		const base = builtinProviders().find((provider) => provider.id === "anthropic")!;
		// Disable only the guard's read. All native login and persistence code stays identical.
		runtime.registerNativeProvider(anthropicLoginProvider(base, "anthropic", () => undefined));
		await runtime.login("anthropic", "api_key", {
			signal: new AbortController().signal, prompt: async () => apiKey.key, notify: () => {},
		});
		assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8")).anthropic, apiKey);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a slot filled by the other auth type while a dialog is open is not overwritten", async () => {
	let current: typeof oauth | undefined;
	const login = protectAnthropicLogin("anthropic-account-2", "api_key", () => current, async () => {
		current = oauth;
		return apiKey;
	});
	await assert.rejects(login(), /It was not replaced/);
	assert.deepEqual(current, oauth);
});
