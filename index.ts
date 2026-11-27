// MIT license: Anthropic OAuth request shaping is vendored from gotgenes/pi-anthropic-auth.
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { createPayloadStream } from "./provider-payload-stream.ts";
import {
	AutomaticRecoveryArbiter,
	isPolicyRefusal,
	type AutomaticRecoveryLease,
	type RecoveryCategory,
} from "./recovery-safety.ts";
import { mutateProxyAuth } from "./auth-file-transaction.ts";
import { anthropicLoginProvider } from "./anthropic-login.ts";
import { commandArgumentsProblem } from "./command-arguments.ts";
import { multiAccountCompletions, type AccountChoice } from "./command-completions.ts";
import { mergeStateDeltas, mutateStateFile } from "./state-file-transaction.ts";
import { normalizeModelPins, persistModelPin, validModelPinScope } from "./model-pins.ts";
import { mutateConfigFile, mutateConfigFileAsync } from "./config-file-transaction.ts";
import { replaceFileSync } from "./replace-file.ts";
import { createHash } from "node:crypto";
import {
	accessSync,
	appendFileSync,
	constants as fsConstants,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { Readable } from "node:stream";
import { dirname, join } from "node:path";
import { getModel as getHostModel } from "@earendil-works/pi-ai/compat";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_BASE,
	CURSOR_PROXY_PLACEHOLDER_KEY,
	isCursorProviderId,
	isCursorProviderInstalled,
	refreshCursorCredentials,
	setupCursorSubscription,
} from "./cursor-bridge.ts";
import { droppedPreviousSummary, restorePreviousSummary } from "./compaction-summary.ts";
import {
	admitRequest,
	dropOwnLoopbackPublications,
	parseProxyPath,
	placeholderKeyFor,
	preservedModelOverrides,
	proxyFamilyFor,
	publishedRouteFor,
	shapeUpstreamRequest,
	type ProxyFamily,
	type ProxyRoute,
} from "./slot-proxy.ts";
import {
	applyRestoreAll,
	applyShadowAll,
	isChildFacingPlaceholderForSlot,
	mergeParentAuth,
	needsAuthShadow,
} from "./slot-proxy-auth.ts";
import {
	classifyChildUsability,
	defaultRouteWarning,
	type ChildUsability,
} from "./child-usability.ts";
import {
	checkAuthShape,
	checkModelsShape,
	checkSettingsTracksActive,
	describeContractDrift,
	observedAssumptions,
	piAutoPersistsSelectedModel,
	piHasContextWithSystem,
	type ShapeVerdict,
} from "./pi-contract.ts";
import {
	DEFAULT_PROVIDER_PRIORITY,
	describePriority,
	normalizeGroup,
	normalizePriority,
} from "./provider-priority.ts";
import {
	classifyRouteAttempt,
	rankAutomaticRouteCandidates,
	type RouteAttemptFact,
	type RouteDecision,
	type RouteFailurePatterns,
	type RouteModelRef,
	type RouteRequestFact,
	selectOperationRoute,
	type ScoredRouteCandidate,
} from "./completion-route-planner.ts";
import {
	DEFAULT_CONTEXT_GUARD_SETTINGS,
	createOverheadTracker,
	decideGuard,
	estimateRawTokens,
	planElision,
	type ContextGuardSettings,
	type GuardMessage,
	type OverheadTracker,
} from "./context-guard.ts";

// external: Pi binds public imports to the host SDK; a private copy can have a different catalog and auth.
type PiAiOauthBridge = {
	era: "provider-factories";
	anthropic: {
		login: (callbacks: any) => Promise<any>;
		refresh: (credentials: any, signal: AbortSignal) => Promise<any>;
	};
	codex: {
		usesCallbackServer: boolean;
		login: (callbacks: any) => Promise<any>;
		refresh: (credentials: any, signal: AbortSignal) => Promise<any>;
		getApiKey: (credentials: any) => string;
	};
	kimi?: {
		login: (callbacks: any) => Promise<any>;
		refresh: (credentials: any, signal: AbortSignal) => Promise<any>;
		getApiKey: (credentials: any) => string;
	};
	xai?: {
		refresh: (credentials: any, signal: AbortSignal) => Promise<any>;
	};
};

let piAiOauthBridge: PiAiOauthBridge | undefined;
let piAiOauthLoadError: string | undefined;

// external: Pi passes legacy callbacks while pi-ai OAuth expects AuthInteraction.
function toAuthInteraction(callbacks: any) {
	return {
		signal: callbacks?.signal,
		notify(event: any) {
			if (!event || typeof event !== "object") {
				callbacks?.onProgress?.(String(event ?? ""));
				return;
			}
			if (event.type === "auth_url") {
				callbacks?.onAuth?.({ url: event.url, instructions: event.instructions });
				return;
			}
			if (event.type === "device_code") {
				callbacks?.onDeviceCode?.({
					userCode: event.userCode,
					verificationUri: event.verificationUri,
					intervalSeconds: event.intervalSeconds,
					expiresInSeconds: event.expiresInSeconds,
				});
				return;
			}
			callbacks?.onProgress?.(
				typeof event.message === "string" ? event.message : JSON.stringify(event),
			);
		},
		prompt(prompt: any) {
			if (prompt?.type === "select") return callbacks.onSelect(prompt);
			if (prompt?.type === "manual_code" && callbacks?.onManualCodeInput) {
				return callbacks.onManualCodeInput();
			}
			return callbacks.onPrompt({
				message: prompt?.message ?? "",
				placeholder: prompt?.placeholder,
				allowEmpty: prompt?.allowEmpty,
			});
		},
	};
}


function adaptProviderFactories(): PiAiOauthBridge | undefined {
	const providers = builtinProviders();
	const oauth = (id: string): any => providers.find((provider) => provider.id === id)?.auth?.oauth;
	const anthropicOauth = oauth("anthropic");
	const codexOauth = oauth("openai-codex");
	const kimiOauth = oauth("kimi-coding");
	const xaiOauth = oauth("xai");
	if (
		typeof anthropicOauth?.login !== "function" ||
		typeof anthropicOauth?.refresh !== "function" ||
		typeof codexOauth?.login !== "function" ||
		typeof codexOauth?.refresh !== "function"
	) {
		return undefined;
	}
	return {
		era: "provider-factories",
		anthropic: {
			login: (callbacks) => anthropicOauth.login(toAuthInteraction(callbacks)),
			refresh: (credentials, signal) => anthropicOauth.refresh(credentials, signal),
		},
		codex: {
			// external: pi-ai's Codex OAuth uses a local callback server without exposing this flag.
			usesCallbackServer: true,
			login: (callbacks) => codexOauth.login(toAuthInteraction(callbacks)),
			refresh: (credentials, signal) => codexOauth.refresh(credentials, signal),
			getApiKey: (credentials) => credentials.access,
		},
		kimi:
			typeof kimiOauth?.login === "function" &&
			typeof kimiOauth?.refresh === "function"
				? {
						login: (callbacks) => kimiOauth.login(toAuthInteraction(callbacks)),
						refresh: (credentials, signal) => kimiOauth.refresh(credentials, signal),
						getApiKey: (credentials) => credentials.access,
					}
				: undefined,
		xai:
			typeof xaiOauth?.refresh === "function"
				? {
						refresh: (credentials, signal) => xaiOauth.refresh(credentials, signal),
					}
				: undefined,
	};
}

function tryLoadPiAiOauth(): PiAiOauthBridge | undefined {
	if (piAiOauthBridge) return piAiOauthBridge;
	try {
		piAiOauthBridge = adaptProviderFactories();
		piAiOauthLoadError = piAiOauthBridge
			? undefined
			: "the running Pi host exposes no usable pi-ai OAuth provider factories";
	} catch (error) {
		piAiOauthLoadError = error instanceof Error ? error.message : String(error);
	}
	return piAiOauthBridge;
}

function piAiOauthUnavailableReason(): string | undefined {
	tryLoadPiAiOauth();
	return piAiOauthBridge ? undefined : piAiOauthLoadError;
}

function requirePiAiOauth(): PiAiOauthBridge {
	const bridge = tryLoadPiAiOauth();
	if (!bridge) {
		throw new Error(
			`pi-multi-account: subscription (OAuth) login is unavailable — ${piAiOauthLoadError}`,
		);
	}
	return bridge;
}

function piAiGetModel(provider: string, id: string): any {
	try {
		return getHostModel(provider as any, id as any);
	} catch {
		return undefined;
	}
}
import {
	CodexCatalogFetchError,
	compareCodexModelStrength,
	fetchCodexModelCatalog,
	fetchOllamaCloudCatalog,
	rankAnthropicModelIds,
	type CodexCatalogModel,
	type CodexCatalogSnapshot,
} from "./model-catalog.ts";
import {
	ANTHROPIC_API_KEY_BILLING_NOTE,
	fetchUsageSnapshot,
	agyFailureReason,
	formatAgyQuotaLine,
	formatResetDuration,
	formatUsageCompact,
	formatUsageDetails,
	parseAgyQuota,
	parseCodexUsageHeaders,
	mergeUsageSnapshot,
	providerUsageLabel,
	remainingPercent,
	sameUsageReading,
	usageColor,
	usageFamily,
	UsageFetchError,
	windowLabel,
	type UsageSnapshot,
	type UsageWindow,
	type UsageWindowPosition,
} from "./usage.ts";

type ModelRef = `${string}/${string}`;
type ProviderFamily =
	| "anthropic"
	| "openai-codex"
	| "kimi-coding"
	| "qwen"
	| "ollama"
	| "cursor";
type ReasoningLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";
const REASONING_LEVELS: ReasoningLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];
type ReasoningLevelSetting = ReasoningLevel | "auto";

type OpenAICodexAliasConfig = {
	id: string;
	displayName?: string;
	models?: string[];
};
type AnthropicOAuthAliasConfig = {
	id: string;
	displayName?: string;
	models?: string[];
};

type ProviderFailoverConfig = {
	enabled?: boolean;
	autoContinue?: boolean;
	resumeAfterAllAccountsRecover?: boolean;
	autoDiscover?: boolean;
	autoDiscoverModels?: boolean;
	maxAccountsPerProvider?: number;
	includeQwen?: boolean;
	qwenProvider?: string;
	includeOllama?: boolean;
	includeOtherProviders?: boolean;
	includeCursor?: boolean;
	childProxy?: boolean;
	// external: Pi merges provider registrations, preserving auth and OAuth configuration.
	onlyActive?: boolean;
	neverFailoverProviders?: string[];
	providerOrder?: ProviderFamily[];
	providerPriority?: string[];
	cooldownMs?: number;
	probeCooldownMs?: number;
	invalidCooldownMs?: number;
	transientCooldownMs?: number;
	breakerCooldownMs?: number;
	showUsage?: boolean;
	showUsageWindows?: boolean;
	usageRefreshMs?: number;
	usageStatusRefreshMs?: number;
	pendingPollMs?: number;
	maxAutoContinuesPerPrompt?: number;
	fallbacks?: string[];
	openaiCodexAliases?: OpenAICodexAliasConfig[];
	anthropicOAuthAliases?: AnthropicOAuthAliasConfig[];
	limitErrorPatterns?: string[];
	authErrorPatterns?: string[];
	transientErrorPatterns?: string[];
	modelErrorPatterns?: string[];
	ignoreErrorPatterns?: string[];
	continuationPrompt?: string;
	// external: provider quota reset forecasts can change or reset early.
	maxRecheckIntervalMs?: number;
	// external: Pi checks compaction between runs, not during an autonomous run.
	contextGuard?: boolean | Partial<ContextGuardSettings>;
	// external: Pi queues continuation for overflow compaction but not threshold compaction.
	continueAfterCompaction?: boolean;
	// external: pi-ai drops interrupted assistant messages before the next request.
	preserveInterruptedContext?: boolean;
	routeCompactionToHealthyAccount?: boolean;
	compactionWatchdogMs?: number;
	autoRecoverStuck?: boolean;
	debugLog?: boolean;
	preferLatestModel?: boolean;
	reasoningLevel?: ReasoningLevelSetting;
	preferredModels?: Record<string, string[]>;
	pinnedModels?: Record<string, string>;
	failoverWarmupModels?: Record<string, string>;
	resumeIdleTimeoutMs?: number;
	stuckWatchdogMs?: number;
};

type RuntimeConfig = Required<
	Pick<
		ProviderFailoverConfig,
		| "enabled"
		| "autoContinue"
		| "resumeAfterAllAccountsRecover"
		| "autoDiscover"
		| "autoDiscoverModels"
		| "maxAccountsPerProvider"
		| "includeQwen"
		| "qwenProvider"
		| "includeOllama"
		| "includeOtherProviders"
		| "includeCursor"
		| "childProxy"
		| "onlyActive"
		| "neverFailoverProviders"
		| "providerOrder"
		| "providerPriority"
		| "cooldownMs"
		| "probeCooldownMs"
		| "invalidCooldownMs"
		| "transientCooldownMs"
		| "breakerCooldownMs"
		| "showUsage"
		| "showUsageWindows"
		| "usageRefreshMs"
		| "usageStatusRefreshMs"
		| "pendingPollMs"
		| "maxAutoContinuesPerPrompt"
		| "fallbacks"
		| "limitErrorPatterns"
		| "authErrorPatterns"
		| "transientErrorPatterns"
		| "modelErrorPatterns"
		| "ignoreErrorPatterns"
		| "continuationPrompt"
		| "maxRecheckIntervalMs"
		| "continueAfterCompaction"
		| "preserveInterruptedContext"
		| "routeCompactionToHealthyAccount"
		| "autoRecoverStuck"
		| "debugLog"
		| "preferLatestModel"
		| "reasoningLevel"
		| "preferredModels"
		| "pinnedModels"
		| "failoverWarmupModels"
		| "resumeIdleTimeoutMs"
		| "stuckWatchdogMs"
		| "compactionWatchdogMs"
	>
> & {
	openaiCodexAliases: OpenAICodexAliasConfig[];
	anthropicOAuthAliases: AnthropicOAuthAliasConfig[];
	contextGuard: ContextGuardSettings;
};

type SwitchRecord = {
	from: ModelRef;
	to: ModelRef;
	reason: string;
	at: number;
};

type InvalidationRecord = { tokenHash: string; at: number; reason: string };

type ProviderFailoverState = {
	stateVersion?: number;
	exhaustedUntilByProvider?: Record<string, number>;
	exhaustedUntilByModel?: Record<string, number>;
	lastProbeAtByProvider?: Record<string, number>;
	invalidatedByProvider?: Record<string, InvalidationRecord>;
	usageUntrustedUntilByProvider?: Record<string, number>;
	usageByProvider?: Record<string, UsageSnapshot>;
	codexModelCatalogByProvider?: Record<string, CodexCatalogSnapshot>;
	authTypeByProvider?: Record<string, "oauth" | "api_key">;
	pendingContinuationPrompt?: string;
	pendingFrom?: ModelRef;
	pendingSince?: number;
	pendingReason?: string;
	pendingOwner?: string;
	lastSwitches?: SwitchRecord[];
	lastUserModel?: { provider: string; id: string };
	// external: Pi clamps thinking level to the fallback model's capabilities during restore.
	lastUserThinkingLevel?: string;
	lastModelByFamily?: Record<string, string>;
};

const AGENT_DIR =
	process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "provider-failover.json");
const STATE_PATH = join(AGENT_DIR, "provider-failover-state.json");
const AUTH_PATH = join(AGENT_DIR, "auth.json");
const PROXY_OAUTH_PATH = join(AGENT_DIR, "pi-multi-account-proxy-oauth.json");
const MODELS_CONFIG_PATH = join(AGENT_DIR, "models.json");
const SETTINGS_PATH = join(AGENT_DIR, "settings.json");

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

function readPiHostVersion(packageJsonPath: string): string | undefined {
	try {
		const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
		return manifest?.name === PI_PACKAGE_NAME && typeof manifest?.version === "string"
			? manifest.version
			: undefined;
	} catch {
		return undefined;
	}
}

function resolvePiHostVersion(): string {
	const candidates: string[] = [];
	let extensionDir = dirname(fileURLToPath(import.meta.url));
	for (let depth = 0; depth < 16; depth++) {
		candidates.push(
			join(extensionDir, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
		);
		const parent = dirname(extensionDir);
		if (parent === extensionDir) break;
		extensionDir = parent;
	}

	const cliEntry = process.argv[1];
	if (cliEntry) {
		let resolvedEntry = cliEntry;
		try {
			resolvedEntry = realpathSync(cliEntry);
		} catch {
		}
		let cliDir = dirname(resolvedEntry);
		for (let depth = 0; depth < 16; depth++) {
			candidates.push(join(cliDir, "package.json"));
			const parent = dirname(cliDir);
			if (parent === cliDir) break;
			cliDir = parent;
		}
	}

	for (const candidate of new Set(candidates)) {
		const version = readPiHostVersion(candidate);
		if (version) return version;
	}
	return "unknown";
}

const PI_HOST_VERSION = resolvePiHostVersion();

function configuredModelIds(provider: string): string[] {
	try {
		const parsed = JSON.parse(readFileSync(MODELS_CONFIG_PATH, "utf8"));
		const models = parsed?.providers?.[provider]?.models;
		if (Array.isArray(models)) {
			return models
				.filter((model: any) => !model?.type || model.type === "chat")
				.map((model: any) => (typeof model === "string" ? model : model?.id))
				.filter((id: unknown): id is string => typeof id === "string" && id.length > 0);
		}
		if (models && typeof models === "object") return Object.keys(models);
		return [];
	} catch {
		return [];
	}
}

// external: Pi's provider composer replaces the supplied model array, including non-chat models.
function configuredOperationModels(provider: string): any[] {
	try {
		const parsed = JSON.parse(readFileSync(MODELS_CONFIG_PATH, "utf8"));
		const models = parsed?.providers?.[provider]?.models;
		return Array.isArray(models)
			? models.filter((model: any) => model && typeof model === "object" &&
				(model.type === "image" || model.type === "classifier"))
			: [];
	} catch {
		return [];
	}
}

function readHostDefaultModel(): { provider: string; id: string } | undefined {
	try {
		const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
		const provider = parsed?.defaultProvider;
		const id = parsed?.defaultModel;
		if (
			typeof provider === "string" &&
			provider &&
			typeof id === "string" &&
			id
		) {
			return { provider, id };
		}
	} catch {
	}
	return undefined;
}

function readPublishedJson(path: string): { present: boolean; value?: unknown; unreadable?: string } {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { present: false };
	}
	try {
		return { present: true, value: JSON.parse(text) };
	} catch (error) {
		return {
			present: true,
			unreadable: error instanceof Error ? error.message : String(error),
		};
	}
}

function inspectPiContract(active?: { provider: string; id: string }): ShapeVerdict[] {
	const verdicts: ShapeVerdict[] = [];
	const checks: Array<[string, string, (raw: unknown) => ShapeVerdict]> = [
		["auth.json", AUTH_PATH, checkAuthShape],
		["models.json", MODELS_CONFIG_PATH, checkModelsShape],
	];
	if (active && piAutoPersistsSelectedModel(PI_HOST_VERSION)) {
		checks.push([
			"settings.json",
			SETTINGS_PATH,
			(raw) => checkSettingsTracksActive(raw, active),
		]);
	}
	for (const [file, path, check] of checks) {
		const read = readPublishedJson(path);
		if (!read.present) continue;
		if (read.unreadable) {
			verdicts.push({
				file,
				ok: false,
				problems: [`exists but will not parse (${read.unreadable})`],
			});
			continue;
		}
		verdicts.push(check(read.value));
	}
	return verdicts;
}

function slotsAsAChildSeesThem(
	slotIds: readonly string[],
	auth: Record<string, { type?: string }>,
): ChildUsability[] {
	const read = readPublishedJson(MODELS_CONFIG_PATH);
	const published =
		read.present && !read.unreadable && typeof (read.value as any)?.providers === "object"
			? ((read.value as any).providers as Record<string, any>)
			: {};
	return slotIds.map((slotId) => {
		const entry = published[slotId];
		const credentialType = auth[slotId]?.type;
		return classifyChildUsability({
			slotId,
			credential:
				credentialType === "oauth"
					? "oauth"
					: credentialType === "api_key"
						? "api_key"
						: "none",
			builtin: !/-account-\d+$/.test(slotId) && entry === undefined,
			publishedApiKey: typeof entry?.apiKey === "string" ? entry.apiKey : undefined,
			publishedBaseUrl: typeof entry?.baseUrl === "string" ? entry.baseUrl : undefined,
		});
	});
}

type NativeModelEntry = {
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input?: Array<"text" | "image">;
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow?: number;
	maxTokens?: number;
	compat?: Record<string, unknown>;
};

type NativeProviderEntry = {
	api: string;
	baseUrl: string;
	models: unknown[];
	compat?: Record<string, unknown>;
	// external: Pi requires a credential for a registered provider.
	apiKey?: string;
};

// external: Pi rejects string model entries and discards the entire models.json file.
function nativeModelEntry(model: unknown): NativeModelEntry | undefined {
	if (typeof model === "string") {
		return model.length > 0 ? { id: model } : undefined;
	}
	if (!model || typeof model !== "object") return undefined;
	const rec = model as Record<string, unknown>;
	const id = typeof rec.id === "string" ? rec.id : "";
	if (!id) return undefined;
	const entry: NativeModelEntry = { id };
	if (typeof rec.name === "string" && rec.name.length > 0) entry.name = rec.name;
	if (typeof rec.api === "string" && rec.api.length > 0) entry.api = rec.api;
	if (typeof rec.baseUrl === "string" && rec.baseUrl.length > 0) {
		entry.baseUrl = rec.baseUrl;
	}
	if (typeof rec.reasoning === "boolean") entry.reasoning = rec.reasoning;
	if (rec.thinkingLevelMap && typeof rec.thinkingLevelMap === "object") {
		entry.thinkingLevelMap = rec.thinkingLevelMap as NativeModelEntry["thinkingLevelMap"];
	}
	if (Array.isArray(rec.input)) {
		const input = rec.input.filter(
			(value): value is "text" | "image" => value === "text" || value === "image",
		);
		if (input.length) entry.input = input;
	}
	if (rec.cost && typeof rec.cost === "object") {
		const cost = rec.cost as Record<string, unknown>;
		if (
			typeof cost.input === "number" &&
			typeof cost.output === "number" &&
			typeof cost.cacheRead === "number" &&
			typeof cost.cacheWrite === "number"
		) {
			entry.cost = {
				input: cost.input,
				output: cost.output,
				cacheRead: cost.cacheRead,
				cacheWrite: cost.cacheWrite,
			};
		}
	}
	if (typeof rec.contextWindow === "number") entry.contextWindow = rec.contextWindow;
	if (typeof rec.maxTokens === "number") entry.maxTokens = rec.maxTokens;
	if (rec.compat && typeof rec.compat === "object") {
		entry.compat = rec.compat as Record<string, unknown>;
	}
	return entry;
}

function nativeModelEntries(models: unknown[]): NativeModelEntry[] {
	const out: NativeModelEntry[] = [];
	for (const model of models) {
		const entry = nativeModelEntry(model);
		if (entry) out.push(entry);
	}
	return out;
}

async function provisionNativeSlot(provider: string, entry: NativeProviderEntry, canCommit: () => boolean): Promise<void> {
	try {
		if (!canCommit()) return;
		const models = nativeModelEntries(entry.models);
		try {
			writeFileSync(MODELS_CONFIG_PATH, "{}\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
		} catch (error: any) {
			if (error?.code !== "EEXIST") throw error;
		}
		await mutateConfigFileAsync(
			MODELS_CONFIG_PATH,
			(parsed) => {
				const providers =
					typeof parsed?.providers === "object" && parsed.providers !== null
						? parsed.providers
						: {};
				const existing = providers[provider];
				const normalized: Record<string, unknown> = {
					api: entry.api,
					baseUrl: entry.baseUrl,
					models,
				};
				if (entry.apiKey) normalized.apiKey = entry.apiKey;
				if (entry.compat) normalized.compat = entry.compat;
				const modelOverrides = preservedModelOverrides(existing);
				if (modelOverrides) normalized.modelOverrides = modelOverrides;
				if (
					existing?.baseUrl === normalized.baseUrl &&
					existing?.api === normalized.api &&
					existing?.apiKey === normalized.apiKey &&
					JSON.stringify(existing?.models ?? []) === JSON.stringify(models)
				) {
					return undefined;
				}
				return { providers: { ...providers, [provider]: normalized } };
			},
			canCommit,
			2,
		);
	} catch (error: any) {
		logEvent("models_json_publish_failed", { provider, code: error?.code ?? String(error?.message ?? error) });
	}
}

function unprovisionOwnLoopbacks(slotIds?: readonly string[]): void {
	try {
		if (!existsSync(MODELS_CONFIG_PATH)) return;
		const parsed = JSON.parse(readFileSync(MODELS_CONFIG_PATH, "utf8"));
		const providers =
			typeof parsed?.providers === "object" && parsed.providers !== null
				? parsed.providers
				: undefined;
		if (!providers) return;
		const nextProviders = dropOwnLoopbackPublications(providers, slotIds);
		if (JSON.stringify(nextProviders) === JSON.stringify(providers)) return;
		mutateConfigFile(
			MODELS_CONFIG_PATH,
			(disk) => {
				const current =
					typeof disk?.providers === "object" && disk.providers !== null
						? disk.providers
						: undefined;
				if (!current) return undefined;
				const dropped = dropOwnLoopbackPublications(current, slotIds);
				return JSON.stringify(dropped) === JSON.stringify(current)
					? undefined
					: { providers: dropped };
			},
			undefined,
			2,
		);
	} catch (error: any) {
		logEvent("models_json_unpublish_failed", { code: error?.code ?? String(error?.message ?? error) });
	}
}

const DEBUG_LOG_PATH = join(AGENT_DIR, "provider-failover-debug.log");
const DEBUG_LOG_MAX_BYTES = 4 * 1024 * 1024;
const STATE_VERSION = 5;
const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const DEFAULT_PROBE_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_INVALID_COOLDOWN_MS = 365 * 24 * 60 * 60 * 1000;
const DEFAULT_TRANSIENT_COOLDOWN_MS = 60 * 1000;
const DEFAULT_USAGE_REFRESH_MS = 5 * 60 * 1000;
const DEFAULT_USAGE_STATUS_REFRESH_MS = 60 * 1000;
const CODEX_MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;
const OLLAMA_MODEL_CATALOG_TTL_MS = 30 * 60 * 1000;
const MIN_ANTHROPIC_USAGE_REFRESH_MS = 10 * 60 * 1000;
const MAX_MIGRATED_COOLDOWN_MS = 8 * 24 * 60 * 60 * 1000;
// external: Codex may report a long rolling-window reset while its short window has already recovered.
const MAX_LIVE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
// external: Provider quota reset forecasts can change when windows refresh early.
const MAX_RECHECK_INTERVAL_MS = 10 * 60 * 1000;
const MIN_PENDING_WAKE_MS = 1000;
// external: Provider usage endpoints can report quota headroom while a session is rate-limited.
const LIMIT_STREAK_WINDOW_MS = 15 * 60 * 1000;
const USAGE_UNTRUSTED_MS = 30 * 60 * 1000;
const SESSION_LIMIT_FLOOR_MS = 5 * 60 * 1000;
const AUTH_CHANGE_POLL_MS = 5000;
const PENDING_POLL_MS = 60 * 1000;
const QUEUE_FLUSH_SOON_MS = 10 * 1000;
const ANTI_PINGPONG_MS = 60 * 1000;
const VERSION = "1.24.0";
function sourceFingerprint(): string {
	try {
		const root = dirname(fileURLToPath(import.meta.url));
		const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		const files = (manifest.files as string[]).filter((name) => name.endsWith(".ts")).sort();
		const hash = createHash("sha256");
		for (const name of files) hash.update(name).update(readFileSync(join(root, name)));
		const cursorDir = join(root, "cursor");
		if (existsSync(cursorDir)) {
			for (const child of readdirSync(cursorDir).sort()) {
				if (!child.endsWith(".ts")) continue;
				const rel = `cursor/${child}`;
				hash.update(rel).update(readFileSync(join(cursorDir, child)));
			}
		}
		return hash.digest("hex").slice(0, 12);
	} catch { return "unknown"; }
}
const LOADED_SOURCE_FINGERPRINT = sourceFingerprint();
const TRANSIENT_PENDING_PREFIX = "temporary provider failure:";
const SELECTED_FALLBACK_PENDING_PREFIX = "selected fallback:";
const BUSY_RETRY_REASON = "previous turn was still busy; auto-retry";
// external: Pi may surface one Codex 401 as response, message and agent error hooks.
const MAX_CONSECUTIVE_AUTH_FAILURES = 8;
const TRANSIENT_AUTH_COOLDOWN_MS = 60 * 1000;

const MAX_SAME_KEY_AUTH_FAILURES = 3;

const RESUME_IDLE_TIMEOUT_MS = 90 * 1000;
const STUCK_WATCHDOG_MS = 180 * 1000;
const STUCK_REMINDER_MS = 120 * 1000;
const ABORT_REPORT_GRACE_WINDOWS = 4;
// external: large Opus summaries can take more than three minutes.
const COMPACTION_WATCHDOG_MS = 8 * 60 * 1000;
const COMPACTION_MAX_ATTEMPTS = 3;
const COMPACTION_UNFIT_MS = 30 * 60 * 1000;
const COMPACTION_UNFIT_PATTERNS = [
	"insufficient balance",
	"insufficient_quota",
	"no resource package",
	"creditserror",
	"requires a subscription",
	"requires both a pro",
	"do not have access",
	"does not exist or you do not have access",
	"no endpoints found",
	"unable to verify your membership",
	"exceeds the context window",
	"usage limit",
	"quota",
];

const BREAKER_FAILURE_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 10 * 60 * 1000;
const TRANSIENT_RETRY_MAX_DELAY_MS = 15 * 60 * 1000;

const ANTHROPIC_BASE = "anthropic";
const CODEX_BASE = "openai-codex";
const OLLAMA_BASE = "ollama";
const DEFAULT_QWEN_PROVIDER = "alibaba";

const METERED_NATIVE_PROVIDERS = new Set(["deepseek", "openai"]);

const DEFAULT_LIMIT_PATTERNS = [
	"429",
	"rate limit",
	"rate_limit",
	"too many requests",
	"usage limit",
	"usage_limit_reached",
	"usage_not_included",
	"quota",
	"insufficient_quota",
	"out of budget",
	"available balance",
	"billing hard limit",
	"monthly usage limit",
	"freeusagelimiterror",
	"gousagelimiterror",
	"payment required",
	"limit_source",
	"remaining balance",
	"upgrade to a paid account",
	"insufficient credits",
	"insufficient_credits",
	"out of credits",
	"credit balance is too low",
	"add credits",
	"third-party apps now draw from your extra usage",
	// external: gRPC uses status 8 for resource exhaustion.
	"resource_exhausted",
];

export function isTemporaryApiThrottle(errorText: string): boolean {
	if (/^429 status code \(no body\)$/i.test(errorText.trim())) return true;
	if (!/^429\s*:/i.test(errorText.trim())) return false;
	const start = errorText.indexOf("{");
	if (start < 0) return false;
	try {
		const body = JSON.parse(errorText.slice(start));
		const error = body?.error ?? body;
		return error?.code === "rate_limit_exceeded" &&
			error?.type === "rate_limit_error";
	} catch (error) {
		if (error instanceof SyntaxError) return false;
		throw error;
	}
}

const DEFAULT_AUTH_ERROR_PATTERNS = [
	"401",
	"unauthorized",
	"authentication_error",
	"could not parse your authentication token",
	"authentication token has been invalidated",
	"token has been invalidated",
	"invalid authentication",
	"invalid_token",
	"invalid token",
	"token has expired",
	"token expired",
	"expired token",
	"invalid_grant",
	"invalid api key",
	"incorrect api key",
	"no api key",
	"missing api key",
	"revoked",
	"oauth token",
];

const DEFAULT_TRANSIENT_ERROR_PATTERNS = [
	"408",
	"425",
	"500",
	"502",
	"503",
	"504",
	"529",
	"overloaded",
	"service unavailable",
	"temporarily unavailable",
	"internal server error",
	"bad gateway",
	"gateway timeout",
	"request timeout",
	"timed out",
	"timeout",
	"connection reset",
	"econnreset",
	"econnrefused",
	"enetunreach",
	"fetch failed",
	"network error",
	"socket hang up",
	"stream disconnected",
	"websocket error",
	"server error",
	// external: Anthropic SDK and undici report connection failures using these messages.
	"connection error",
	"terminated",
	"unable to verify model access right now",
];

function isCursorUpstreamStall(text: string): boolean {
	const lower = text.toLowerCase();
	return (
		(lower.includes("cursor run stalled") && lower.includes("timed out")) ||
		(lower.includes("produced no output") && lower.includes("timed out"))
	);
}

const DEFAULT_MODEL_ERROR_PATTERNS = [
	"model_not_found",
	"model not found",
	"unsupported model",
	"unknown model",
	"model is unavailable",
	"model unavailable",
	"does not have access to model",
	"do not have access to model",
];

const TERMINAL_AUTH_ERROR_PATTERNS = [
	"authentication token has been invalidated",
	"token has been invalidated",
	"invalid_grant",
	"revoked",
	"invalid api key",
	"invalid api-key",
	"incorrect api key",
	"incorrect api-key",
	"api-key provided",
	"apikey-error",
];

const FORCE_REFRESH_AUTH_ERROR_PATTERNS = [
	"authentication token has been invalidated",
	"token has been invalidated",
	"token has expired",
	"token expired",
	"expired token",
];

const TERMINAL_REFRESH_ERROR_PATTERNS = [
	"invalid_grant",
	"refresh_token_reused",
	"revoked",
];

const DEFAULT_IGNORE_PATTERNS = [
	"context overflow",
	"context window",
	"context length",
	"maximum context",
	"too many tokens",
	"token limit exceeded",
	"input is too long",
];

const DEFAULT_CONTINUATION_PROMPT = [
	"Provider failover activated: switched to {to} after {from} hit a quota or rate limit.",
	"Continue the interrupted task from where it stopped.",
	"Anything the interrupted turn already did was attempted, so verify the current state instead of redoing it, and do not restart the task from the beginning.",
].join(" ");

const LEGACY_CONTINUATION_PROMPT = [
	"Provider failover activated: switched to {to} after {from} hit a quota or rate limit.",
	"Continue the interrupted task from where it stopped.",
	"The interrupted turn itself is preserved verbatim in this session as a [handoff:interrupted-turn] record — read it before acting:",
	"it contains the reasoning and output of that turn plus every tool call it issued, marking which ones never returned a result.",
	"Anything shown there was already attempted, so verify the current state instead of redoing it, and do not restart the task from the beginning.",
].join(" ");

const HANDOFF_MARKER = "[handoff:interrupted-turn]";
const HANDOFF_MAX_TEXT = 4000;
const HANDOFF_MAX_THINKING = 3000;
const HANDOFF_MAX_ARGS = 800;
const HANDOFF_MAX_RESULT = 1000;
const HANDOFF_MAX_TOOL_CALLS = 12;
const HANDOFF_MAX_ERROR = 400;

function clipHandoff(value: string, max: number): string {
	const text = value.trim();
	if (text.length <= max) return text;
	const head = Math.ceil(max * 0.6);
	const tail = max - head;
	return `${text.slice(0, head)}\n…[${text.length - max} characters omitted]…\n${text.slice(-tail)}`;
}

function handoffBlockText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: any) =>
			block && typeof block === "object" && block.type === "text"
				? String(block.text ?? "")
				: "",
		)
		.filter(Boolean)
		.join("\n");
}

/**
 * Render the verbatim handoff record for one interrupted assistant message.
 * Returns undefined when the turn carries nothing worth preserving (a turn aborted
 * before it produced anything), so we leave those to pi's normal drop path.
 */
export function renderHandoffRecord(
	message: any,
	resultsByCallId: Map<string, any>,
): string | undefined {
	const texts: string[] = [];
	const thinking: string[] = [];
	const toolCalls: any[] = [];
	for (const block of Array.isArray(message?.content) ? message.content : []) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && typeof block.text === "string") {
			if (block.text.trim()) texts.push(block.text);
		} else if (block.type === "thinking") {
			// external: Redacted thinking is an opaque provider-encrypted payload.
			if (!block.redacted && typeof block.thinking === "string" && block.thinking.trim())
				thinking.push(block.thinking);
		} else if (block.type === "toolCall") {
			toolCalls.push(block);
		}
	}
	const errorMessage =
		typeof message?.errorMessage === "string" ? message.errorMessage.trim() : "";
	if (!texts.length && !thinking.length && !toolCalls.length) return undefined;

	const ref =
		message?.provider && message?.model
			? `${message.provider}/${message.model}`
			: "the previous account";
	const stopped = message?.stopReason === "aborted" ? "cancelled" : "interrupted";
	const lines: string[] = [
		`${HANDOFF_MARKER} The turn below ran on ${ref} and was ${stopped} before it finished.`,
		"Pi does not replay interrupted turns, so its content is reproduced here verbatim and will otherwise be lost.",
		"Treat everything in this record as work ALREADY ATTEMPTED: verify the current state before redoing any of it, and continue from the stopping point rather than from the start.",
	];
	if (thinking.length) {
		lines.push(
			"",
			"--- reasoning of the interrupted turn (verbatim) ---",
			clipHandoff(thinking.join("\n"), HANDOFF_MAX_THINKING),
		);
	}
	if (texts.length) {
		lines.push(
			"",
			"--- output written before the interruption (verbatim) ---",
			clipHandoff(texts.join("\n"), HANDOFF_MAX_TEXT),
		);
	}
	if (toolCalls.length) {
		lines.push("", "--- tool calls issued in that turn ---");
		const shown = toolCalls.slice(0, HANDOFF_MAX_TOOL_CALLS);
		shown.forEach((call: any, index: number) => {
			let args = "";
			try {
				args = JSON.stringify(call?.arguments ?? {});
			} catch {
				args = "<unserializable arguments>";
			}
			lines.push(
				`${index + 1}. ${String(call?.name ?? "unknown")} — arguments: ${clipHandoff(args, HANDOFF_MAX_ARGS)}`,
			);
			const result = resultsByCallId.get(String(call?.id));
			if (!result) {
				lines.push(
					"   result: NONE — the turn was interrupted before this call returned. Its effect is UNKNOWN and must be checked.",
				);
				return;
			}
			const body = clipHandoff(handoffBlockText(result.content), HANDOFF_MAX_RESULT);
			lines.push(
				`   result${result.isError ? " (error)" : ""}: ${body || "<empty>"}`,
			);
		});
		if (toolCalls.length > shown.length)
			lines.push(
				`…and ${toolCalls.length - shown.length} further tool call(s) omitted from this record.`,
			);
	}
	if (errorMessage) {
		lines.push(
			"",
			`--- why it stopped ---`,
			clipHandoff(errorMessage, HANDOFF_MAX_ERROR),
		);
	}
	lines.push("", `--- end of ${HANDOFF_MARKER} ---`);
	return lines.join("\n");
}

/**
 * Replace every interrupted assistant message with a verbatim `user` handoff record and
 * fold in (and remove) the tool results that belonged to it. Returns the original array
 * when there is nothing to preserve, so the caller can skip the hook result entirely.
 */
export function preserveInterruptedTurns(messages: any[]): any[] {
	if (!Array.isArray(messages) || messages.length === 0) return messages;
	const interrupted = messages.filter(
		(message: any) =>
			message?.role === "assistant" &&
			(message.stopReason === "error" || message.stopReason === "aborted"),
	);
	if (interrupted.length === 0) return messages;

	const resultsByCallId = new Map<string, any>();
	for (const message of messages) {
		if (message?.role === "toolResult" && message.toolCallId != null)
			resultsByCallId.set(String(message.toolCallId), message);
	}
	const foldedResultIds = new Set<string>();
	const rendered = new Map<any, string>();
	for (const message of interrupted) {
		const record = renderHandoffRecord(message, resultsByCallId);
		if (!record) continue;
		const alreadyDelivered = messages
			.slice(messages.indexOf(message) + 1)
			.some(
				(later: any) =>
					later?.role === "user" && handoffBlockText(later.content).includes(record),
			);
		rendered.set(message, alreadyDelivered ? "" : record);
		for (const block of Array.isArray(message.content) ? message.content : []) {
			if (block?.type === "toolCall" && block.id != null)
				foldedResultIds.add(String(block.id));
		}
	}
	if (rendered.size === 0) return messages;

	const out: any[] = [];
	for (const message of messages) {
		const record = rendered.get(message);
		if (record === "") continue;
		if (record) {
			out.push({
				role: "user",
				content: [{ type: "text", text: record }],
				timestamp: message.timestamp,
			});
			continue;
		}
		if (
			message?.role === "toolResult" &&
			message.toolCallId != null &&
			foldedResultIds.has(String(message.toolCallId))
		)
			continue;
		out.push(message);
	}
	return out;
}

/** Return the interrupted-turn handoff from a session branch, or an empty string if none exists. */
export function interruptedTurnNote(branch: any[]): string {
	const messages = (Array.isArray(branch) ? branch : [])
		.filter((entry: any) => entry?.type === "message" && entry.message)
		.map((entry: any) => entry.message);
	const last = [...messages].reverse().find((message: any) => message?.role === "assistant");
	if (!last || (last.stopReason !== "error" && last.stopReason !== "aborted")) return "";
	const results = new Map<string, any>();
	for (const message of messages) {
		if (message?.role === "toolResult" && message.toolCallId != null)
			results.set(String(message.toolCallId), message);
	}
	return (
		renderHandoffRecord(last, results) ??
		`The interrupted turn had written no output and issued no tool calls before it stopped, so there is no ${HANDOFF_MARKER} record to read: nothing from that turn was lost. The earlier transcript is the complete state.`
	);
}

const DEFAULT_PROVIDER_ORDER: ProviderFamily[] = [
	"anthropic",
	"openai-codex",
	"kimi-coding",
	"cursor",
	"qwen",
	"ollama",
];

const CODEX_MODEL_DEFS: Record<string, Record<string, unknown>> = {
	"gpt-5.3-codex-spark": {
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3 Codex Spark",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
		input: ["text"],
		cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 128000,
	},
	"gpt-5.4": {
		id: "gpt-5.4",
		name: "GPT-5.4",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
		input: ["text", "image"],
		cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
	"gpt-5.4-mini": {
		id: "gpt-5.4-mini",
		name: "GPT-5.4 mini",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
		input: ["text", "image"],
		cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
	"gpt-5.5": {
		id: "gpt-5.5",
		name: "GPT-5.5",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
		input: ["text", "image"],
		cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
};

const DEFAULT_CODEX_MODELS = [
	"gpt-5.5",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.3-codex-spark",
];
const DEFAULT_ANTHROPIC_MODELS = [
	"claude-opus-5",
	"claude-opus-4-8",
	"claude-opus-4-5",
	"claude-sonnet-4-6",
	"claude-sonnet-4-5",
	"claude-haiku-4-5",
];

const DEFAULT_OLLAMA_MODELS = ["glm-5.2:cloud"];
const DEFAULT_QWEN_MODELS = ["qwen3.8-max", "qwen-max", "qwen-plus"];
const DEFAULT_CURSOR_MODELS = ["cursor-grok-4.6", "grok-4.6", "composer-2.5"];

const DEFAULT_CONFIG: ProviderFailoverConfig = {
	enabled: true,
	autoContinue: true,
	resumeAfterAllAccountsRecover: true,
	autoDiscover: true,
	autoDiscoverModels: true,
	maxAccountsPerProvider: 10,
	includeQwen: true,
	qwenProvider: DEFAULT_QWEN_PROVIDER,
	includeOllama: true,
	includeOtherProviders: true,
	includeCursor: true,
	childProxy: true,
	neverFailoverProviders: [],
	providerOrder: DEFAULT_PROVIDER_ORDER,
	providerPriority: DEFAULT_PROVIDER_PRIORITY,
	cooldownMs: DEFAULT_COOLDOWN_MS,
	probeCooldownMs: DEFAULT_PROBE_COOLDOWN_MS,
	invalidCooldownMs: DEFAULT_INVALID_COOLDOWN_MS,
	transientCooldownMs: DEFAULT_TRANSIENT_COOLDOWN_MS,
	breakerCooldownMs: BREAKER_COOLDOWN_MS,
	showUsage: true,
	showUsageWindows: true,
	usageRefreshMs: DEFAULT_USAGE_REFRESH_MS,
	usageStatusRefreshMs: DEFAULT_USAGE_STATUS_REFRESH_MS,
	pendingPollMs: PENDING_POLL_MS,
	maxAutoContinuesPerPrompt: 8,
	fallbacks: [],
	openaiCodexAliases: [],
	anthropicOAuthAliases: [],
	limitErrorPatterns: DEFAULT_LIMIT_PATTERNS,
	authErrorPatterns: DEFAULT_AUTH_ERROR_PATTERNS,
	transientErrorPatterns: DEFAULT_TRANSIENT_ERROR_PATTERNS,
	modelErrorPatterns: DEFAULT_MODEL_ERROR_PATTERNS,
	ignoreErrorPatterns: DEFAULT_IGNORE_PATTERNS,
	continuationPrompt: DEFAULT_CONTINUATION_PROMPT,
	maxRecheckIntervalMs: MAX_RECHECK_INTERVAL_MS,
	contextGuard: true,
	continueAfterCompaction: true,
	preserveInterruptedContext: true,
	routeCompactionToHealthyAccount: true,
	autoRecoverStuck: true,
	debugLog: true,
	preferLatestModel: true,
	reasoningLevel: "auto",
	preferredModels: {},
	pinnedModels: {},
	failoverWarmupModels: {},
	resumeIdleTimeoutMs: RESUME_IDLE_TIMEOUT_MS,
	stuckWatchdogMs: STUCK_WATCHDOG_MS,
	compactionWatchdogMs: COMPACTION_WATCHDOG_MS,
};


function ensureDefaultConfig() {
	if (existsSync(CONFIG_PATH)) return;
	mkdirSync(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
	try {
		writeFileSync(CONFIG_PATH, `${JSON.stringify(DEFAULT_CONFIG, null, "\t")}\n`,
			{ encoding: "utf8", mode: 0o600, flag: "wx" });
	} catch (error: any) {
		if (error?.code !== "EEXIST") throw error;
	}
}

function positiveOr(value: unknown, fallback: number) {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: fallback;
}

function normalizeContextGuard(value: unknown): ContextGuardSettings {
	const defaults = DEFAULT_CONTEXT_GUARD_SETTINGS;
	if (value === false) return { ...defaults, enabled: false };
	if (value === true || value === undefined || value === null) return { ...defaults };
	if (typeof value !== "object") return { ...defaults };
	const raw = value as Partial<ContextGuardSettings>;
	const share = (candidate: unknown, fallback: number) =>
		typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0 && candidate <= 1
			? candidate
			: fallback;
	const settings: ContextGuardSettings = {
		enabled: raw.enabled ?? true,
		softPercent: share(raw.softPercent, defaults.softPercent),
		targetPercent: share(raw.targetPercent, defaults.targetPercent),
		compactPercent: share(raw.compactPercent, defaults.compactPercent),
		keepVerbatimTokens: positiveOr(raw.keepVerbatimTokens, defaults.keepVerbatimTokens),
		minElideTokens: positiveOr(raw.minElideTokens, defaults.minElideTokens),
		maxWindowTokens:
			typeof raw.maxWindowTokens === "number" &&
			Number.isFinite(raw.maxWindowTokens) &&
			raw.maxWindowTokens >= 0
				? raw.maxWindowTokens
				: defaults.maxWindowTokens,
	};
	if (settings.targetPercent >= settings.softPercent) {
		settings.targetPercent = Math.max(0.1, settings.softPercent - 0.15);
	}
	return settings;
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

function patternsWithDefaults(value: unknown, defaults: string[]): string[] {
	const merged = [...defaults];
	for (const pattern of stringArray(value)) {
		if (!merged.some((known) => known.toLowerCase() === pattern.toLowerCase()))
			merged.push(pattern);
	}
	return merged;
}

function normalizeConfig(raw: ProviderFailoverConfig): RuntimeConfig {
	const configured =
		Array.isArray(raw.providerOrder) && raw.providerOrder.length > 0
			? raw.providerOrder
			: DEFAULT_PROVIDER_ORDER;
	const order = [
		...configured,
		...DEFAULT_PROVIDER_ORDER.filter((family) => !configured.includes(family)),
	];
	return {
		enabled: raw.enabled ?? true,
		autoContinue: raw.autoContinue ?? true,
		resumeAfterAllAccountsRecover:
			raw.resumeAfterAllAccountsRecover ?? true,
		autoDiscover: raw.autoDiscover ?? true,
		autoDiscoverModels: raw.autoDiscoverModels ?? true,
		maxAccountsPerProvider: Math.max(
			1,
			Math.floor(positiveOr(raw.maxAccountsPerProvider, 10)),
		),
		includeQwen: raw.includeQwen ?? true,
		qwenProvider: raw.qwenProvider?.trim() || DEFAULT_QWEN_PROVIDER,
		includeOllama: raw.includeOllama ?? true,
		includeOtherProviders: raw.includeOtherProviders ?? true,
		includeCursor: raw.includeCursor ?? true,
		childProxy: raw.childProxy ?? true,
		onlyActive: raw.onlyActive ?? false,
		neverFailoverProviders: stringArray(raw.neverFailoverProviders),
		providerOrder: order.filter(
			(f): f is ProviderFamily =>
				f === "anthropic" ||
				f === "openai-codex" ||
				f === "kimi-coding" ||
				f === "cursor" ||
				f === "qwen" ||
				f === "ollama",
		),
		providerPriority: Array.isArray(raw.providerPriority)
			? normalizePriority(raw.providerPriority)
			: [...DEFAULT_PROVIDER_PRIORITY],
		cooldownMs: positiveOr(raw.cooldownMs, DEFAULT_COOLDOWN_MS),
		probeCooldownMs: positiveOr(raw.probeCooldownMs, DEFAULT_PROBE_COOLDOWN_MS),
		invalidCooldownMs: positiveOr(
			raw.invalidCooldownMs,
			DEFAULT_INVALID_COOLDOWN_MS,
		),
		transientCooldownMs: positiveOr(
			raw.transientCooldownMs,
			DEFAULT_TRANSIENT_COOLDOWN_MS,
		),
		breakerCooldownMs: positiveOr(raw.breakerCooldownMs, BREAKER_COOLDOWN_MS),
		showUsage: raw.showUsage ?? true,
		showUsageWindows: raw.showUsageWindows ?? true,
		usageRefreshMs: positiveOr(raw.usageRefreshMs, DEFAULT_USAGE_REFRESH_MS),
		usageStatusRefreshMs: positiveOr(
			raw.usageStatusRefreshMs,
			DEFAULT_USAGE_STATUS_REFRESH_MS,
		),
		pendingPollMs: positiveOr(raw.pendingPollMs, PENDING_POLL_MS),
		maxAutoContinuesPerPrompt: Math.floor(
			positiveOr(raw.maxAutoContinuesPerPrompt, 8),
		),
		fallbacks: stringArray(raw.fallbacks),
		openaiCodexAliases: Array.isArray(raw.openaiCodexAliases)
			? raw.openaiCodexAliases
			: [],
		anthropicOAuthAliases: Array.isArray(raw.anthropicOAuthAliases)
			? raw.anthropicOAuthAliases
			: [],
		limitErrorPatterns: patternsWithDefaults(
			raw.limitErrorPatterns,
			DEFAULT_LIMIT_PATTERNS,
		),
		authErrorPatterns: patternsWithDefaults(
			raw.authErrorPatterns,
			DEFAULT_AUTH_ERROR_PATTERNS,
		),
		transientErrorPatterns: patternsWithDefaults(
			raw.transientErrorPatterns,
			DEFAULT_TRANSIENT_ERROR_PATTERNS,
		),
		modelErrorPatterns: patternsWithDefaults(
			raw.modelErrorPatterns,
			DEFAULT_MODEL_ERROR_PATTERNS,
		),
		ignoreErrorPatterns: patternsWithDefaults(
			raw.ignoreErrorPatterns,
			DEFAULT_IGNORE_PATTERNS,
		),
		continuationPrompt:
			!raw.continuationPrompt?.trim() ||
			raw.continuationPrompt.trim() === LEGACY_CONTINUATION_PROMPT
				? DEFAULT_CONTINUATION_PROMPT
				: raw.continuationPrompt.trim(),
		maxRecheckIntervalMs: positiveOr(
			raw.maxRecheckIntervalMs,
			MAX_RECHECK_INTERVAL_MS,
		),
		contextGuard: normalizeContextGuard(raw.contextGuard),
		continueAfterCompaction: raw.continueAfterCompaction ?? true,
		preserveInterruptedContext: raw.preserveInterruptedContext ?? true,
		routeCompactionToHealthyAccount:
			raw.routeCompactionToHealthyAccount ?? true,
		autoRecoverStuck: raw.autoRecoverStuck ?? true,
		debugLog: raw.debugLog ?? true,
		preferLatestModel: raw.preferLatestModel ?? true,
		reasoningLevel:
			raw.reasoningLevel === "off" ||
			raw.reasoningLevel === "minimal" ||
			raw.reasoningLevel === "low" ||
			raw.reasoningLevel === "medium" ||
			raw.reasoningLevel === "high" ||
			raw.reasoningLevel === "xhigh" ||
			raw.reasoningLevel === "max"
				? raw.reasoningLevel
				: "auto",
		preferredModels:
			raw.preferredModels && typeof raw.preferredModels === "object"
				? Object.fromEntries(
						Object.entries(raw.preferredModels)
							.map(([k, v]) => [k, stringArray(v)] as const)
							.filter(([, v]) => v.length > 0),
					)
				: {},
		pinnedModels: normalizeModelPins(raw.pinnedModels),
		failoverWarmupModels: normalizeModelPins(raw.failoverWarmupModels),
		resumeIdleTimeoutMs: positiveOr(
			raw.resumeIdleTimeoutMs,
			RESUME_IDLE_TIMEOUT_MS,
		),
		stuckWatchdogMs: positiveOr(raw.stuckWatchdogMs, STUCK_WATCHDOG_MS),
		compactionWatchdogMs: positiveOr(
			raw.compactionWatchdogMs,
			COMPACTION_WATCHDOG_MS,
		),
	};
}

function loadConfig(): RuntimeConfig {
	ensureDefaultConfig();
	try {
		return normalizeConfig(
			JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as ProviderFailoverConfig,
		);
	} catch {
		return normalizeConfig(DEFAULT_CONFIG);
	}
}

function loadState(): ProviderFailoverState {
	try {
		if (!existsSync(STATE_PATH)) return { stateVersion: STATE_VERSION };
		const state = JSON.parse(
			readFileSync(STATE_PATH, "utf8"),
		) as ProviderFailoverState;
		if (state.stateVersion !== STATE_VERSION) {
			if (state.stateVersion === 4) {
				const migrated: ProviderFailoverState = {
					...state,
					stateVersion: STATE_VERSION,
					exhaustedUntilByModel: {},
				};
				saveState(migrated);
				return migrated;
			}
			const now = Date.now();
			const plausibleCooldowns = Object.fromEntries(
				Object.entries(state.exhaustedUntilByProvider ?? {}).filter(
					([, until]) =>
						Number.isFinite(until) &&
						until > now &&
						until <= now + MAX_MIGRATED_COOLDOWN_MS,
				),
			);
			const migrated: ProviderFailoverState = {
				stateVersion: STATE_VERSION,
				exhaustedUntilByProvider: plausibleCooldowns,
				exhaustedUntilByModel: {},
				lastProbeAtByProvider: state.lastProbeAtByProvider ?? {},
				invalidatedByProvider: {},
				lastSwitches: state.lastSwitches ?? [],
				lastUserModel: state.lastUserModel,
				lastUserThinkingLevel: state.lastUserThinkingLevel,
				lastModelByFamily: state.lastModelByFamily,
			};
			saveState(migrated);
			return migrated;
		}
		return state;
	} catch {
		return { stateVersion: STATE_VERSION };
	}
}

function warnConfigNotSaved(ctx: any, error: any) {
	const code = error?.code ?? String(error?.message ?? error);
	logEvent("config_write_failed", { code });
	ctx.ui.notify(
		`pi-multi-account: applied for this session only; could not save ${CONFIG_PATH} (${code})`,
		"warning",
	);
}

function saveState(state: ProviderFailoverState) {
	try {
		mutateStateFile(STATE_PATH, () => ({ stateVersion: STATE_VERSION, ...state }));
	} catch (error: any) {
		logEvent("state_write_failed", { code: error?.code ?? String(error?.message ?? error) });
	}
}


let debugLogEnabled = false;
const DEBUG_TOKENISH =
	/(sk-[\w-]{8,}|ey[A-Za-z0-9._-]{12,}|Bearer\s+\S+|[A-Za-z0-9_-]{40,})/g;

function redactForLog(text: string): string {
	return text.replace(DEBUG_TOKENISH, "«redacted»");
}

function rotateDebugLogIfNeeded() {
	try {
		const size = statSync(DEBUG_LOG_PATH).size;
		if (size >= DEBUG_LOG_MAX_BYTES) {
			renameSync(DEBUG_LOG_PATH, `${DEBUG_LOG_PATH}.1`);
		}
	} catch {
	}
}

function logEvent(kind: string, data: Record<string, unknown> = {}) {
	if (!debugLogEnabled) return;
	try {
		const safe: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(data)) {
			safe[k] = typeof v === "string" ? redactForLog(v).slice(0, 300) : v;
		}
		const line = `${JSON.stringify({ t: new Date().toISOString(), kind, ...safe })}\n`;
		rotateDebugLogIfNeeded();
		mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true, mode: 0o700 });
		appendFileSync(DEBUG_LOG_PATH, line, { encoding: "utf8", mode: 0o600 });
	} catch {
	}
}

function readDebugLogTail(maxLines: number): string {
	try {
		const raw = readFileSync(DEBUG_LOG_PATH, "utf8");
		const lines = raw.split("\n").filter((l) => l.trim().length > 0);
		return lines.slice(-maxLines).join("\n");
	} catch {
		return "";
	}
}


type AuthEntry = {
	type?: string;
	access?: string;
	refresh?: string;
	expires?: number;
	key?: string;
	accountId?: string;
};

function readAuthFileRaw(): Record<string, AuthEntry> {
	try {
		return JSON.parse(readFileSync(AUTH_PATH, "utf8")) as Record<
			string,
			AuthEntry
		>;
	} catch {
		return {};
	}
}

export function readProxyOAuthSidecar(): Record<string, AuthEntry> {
	try {
		return JSON.parse(readFileSync(PROXY_OAUTH_PATH, "utf8")) as Record<
			string,
			AuthEntry
		>;
	} catch {
		return {};
	}
}

export function writeProxyOAuthSidecar(data: Record<string, AuthEntry>): void {
	const tmp = `${PROXY_OAUTH_PATH}.multi-account.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, "\t")}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	replaceFileSync(tmp, PROXY_OAUTH_PATH);
}

function readAuthFile(): Record<string, AuthEntry> {
	return mergeParentAuth(readAuthFileRaw(), readProxyOAuthSidecar()) as Record<
		string,
		AuthEntry
	>;
}

function writeAuthFile(data: Record<string, AuthEntry>): void {
	const tmp = `${AUTH_PATH}.multi-account.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, "\t")}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	replaceFileSync(tmp, AUTH_PATH);
}

function authFileIsWritable(): boolean {
	try {
		accessSync(AUTH_PATH, fsConstants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/** Whether a refreshed credential can be persisted. */
export function canPersistRefreshedCredentials(
	authStorage: any,
	authWritable: () => boolean = authFileIsWritable,
): boolean {
	// external: Anthropic invalidates the previous refresh token immediately on refresh.
	return (
		typeof authStorage?.modify === "function" ||
		typeof authStorage?.set === "function" ||
		authWritable()
	);
}

/** Persist a refreshed OAuth credential using an available storage path. */
export async function persistRefreshedCredentials(
	authStorage: any,
	provider: string,
	credential: Record<string, unknown>,
	io?: {
		read?: () => Record<string, any>;
		write?: (data: Record<string, any>) => void;
	},
): Promise<boolean> {
	if (!io && isChildFacingPlaceholderForSlot(readAuthFileRaw()[provider], provider)) {
		try {
			let persisted = false;
			mutateProxyAuth(AUTH_PATH, PROXY_OAUTH_PATH, (auth, sidecar) => {
				if (!isChildFacingPlaceholderForSlot(auth[provider], provider) || sidecar[provider]?.type !== "oauth") {
					return { auth, sidecar, changed: false };
				}
				persisted = true;
				return { auth, sidecar: { ...sidecar, [provider]: credential }, changed: true };
			}, "shadow");
			return persisted;
		} catch { return false; }
	}
	if (typeof authStorage?.modify === "function") {
		try {
			await authStorage.modify(provider, () => credential);
			return true;
		} catch {
		}
	}
	if (typeof authStorage?.set === "function") {
		try {
			await authStorage.set(provider, credential);
			return true;
		} catch {
		}
	}
	try {
		if (io) {
			const read = io.read ?? readAuthFileRaw;
			const write = io.write ?? writeAuthFile;
			write({ ...read(), [provider]: credential });
		} else {
			mutateProxyAuth(AUTH_PATH, PROXY_OAUTH_PATH,
				(auth, sidecar) => ({ auth: { ...auth, [provider]: credential }, sidecar, changed: true }), "restore");
		}
		return true;
	} catch {
		return false;
	}
}

/** Remove a credential through Pi's locked AuthStorage surface. */
export async function removeCredentialFromAuthStorage(
	authStorage: any,
	provider: string,
): Promise<boolean> {
	if (typeof authStorage?.delete === "function") {
		try {
			await authStorage.delete(provider);
			return true;
		} catch {
		}
	}
	// external: AuthStorage.modify treats undefined as no change, not deletion.
	return false;
}

function authMtimeMs(): number {
	try {
		return statSync(AUTH_PATH).mtimeMs;
	} catch {
		return 0;
	}
}

function decodeJwtPayload(token: string): any | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		let payload = parts[1].replaceAll("-", "+").replaceAll("_", "/");
		payload += "=".repeat((4 - (payload.length % 4)) % 4);
		return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
	} catch {
		return undefined;
	}
}

function jwtExpMs(token: string): number | undefined {
	const exp = decodeJwtPayload(token)?.exp;
	return typeof exp === "number" && Number.isFinite(exp)
		? exp * 1000
		: undefined;
}

// external: Anthropic access tokens are opaque and do not expose a JWT expiry.
function oauthExpiryMs(entry: AuthEntry): number | undefined {
	const fromJwt = typeof entry.access === "string" ? jwtExpMs(entry.access) : undefined;
	if (fromJwt !== undefined) return fromJwt;
	if (typeof entry.expires !== "number" || !Number.isFinite(entry.expires)) return undefined;
	return entry.expires < 10_000_000_000 ? entry.expires * 1000 : entry.expires;
}

function getCursorSubFromAccessToken(token: string): string | undefined {
	const sub = decodeJwtPayload(token)?.sub;
	return typeof sub === "string" && sub.length > 0 ? sub : undefined;
}

function getCodexAccountIdFromAccessToken(token: string): string | undefined {
	return decodeJwtPayload(token)?.["https://api.openai.com/auth"]
		?.chatgpt_account_id as string | undefined;
}

function getCodexAccountUserIdFromAccessToken(token: string): string | undefined {
	const accountUserId = decodeJwtPayload(token)?.["https://api.openai.com/auth"]
		?.chatgpt_account_user_id;
	return typeof accountUserId === "string" && accountUserId.length > 0
		? accountUserId
		: undefined;
}

function getCodexUserIdFromAccessToken(token: string): string | undefined {
	const userId = decodeJwtPayload(token)?.["https://api.openai.com/auth"]
		?.chatgpt_user_id;
	return typeof userId === "string" && userId.length > 0 ? userId : undefined;
}

function hash12(input: string) {
	return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

function credentialHash(entry: AuthEntry): string | undefined {
	const secret = entry.access ?? entry.key;
	return secret ? hash12(secret) : undefined;
}

function codexWorkspaceMembershipIdentity(entry: AuthEntry): string | undefined {
	if (!entry.access) return undefined;
	const accountUserId = getCodexAccountUserIdFromAccessToken(entry.access);
	if (accountUserId) return `codex-membership:${hash12(accountUserId)}`;
	// external: Codex documents chatgpt_user_id and chatgpt_account_id as membership claims.
	const userId = getCodexUserIdFromAccessToken(entry.access);
	const workspaceId =
		getCodexAccountIdFromAccessToken(entry.access) ??
		(typeof entry.accountId === "string" && entry.accountId.length > 0
			? entry.accountId
			: undefined);
	if (userId && workspaceId)
		return `codex-user-workspace:${hash12(`${userId}\0${workspaceId}`)}`;
	if (userId) return `codex-user:${hash12(userId)}`;
	return undefined;
}

function accountIdentity(entry: AuthEntry): string | undefined {
	const codexMembership = codexWorkspaceMembershipIdentity(entry);
	if (codexMembership) return codexMembership;
	if (typeof entry.accountId === "string" && entry.accountId.length > 0)
		return `acct:${hash12(entry.accountId)}`;
	if (entry.access) {
		const codexId = getCodexAccountIdFromAccessToken(entry.access);
		if (codexId) return `codex:${hash12(codexId)}`;
		const cursorSub = getCursorSubFromAccessToken(entry.access);
		if (cursorSub) return `cursor:${hash12(cursorSub)}`;
		return `tok:${hash12(entry.access)}`;
	}
	if (entry.key) return `key:${hash12(entry.key)}`;
	return undefined;
}

function stableAccountFingerprint(entry: AuthEntry): string | undefined {
	const codexMembership = codexWorkspaceMembershipIdentity(entry);
	if (codexMembership) return codexMembership;
	if (typeof entry.accountId === "string" && entry.accountId.length > 0)
		return `acct:${hash12(entry.accountId)}`;
	if (entry.access) {
		const codexId = getCodexAccountIdFromAccessToken(entry.access);
		if (codexId) return `codex:${hash12(codexId)}`;
	}
	if (entry.key) return `key:${hash12(entry.key)}`;
	return undefined;
}

function rejectDuplicateLogin<T extends AuthEntry>(
	providerId: string,
	credentials: T,
): T {
	const identity = accountIdentity(credentials);
	if (!identity) return credentials;
	const duplicate = Object.entries(readAuthFile()).find(
		([existingId, entry]) =>
			existingId !== providerId && accountIdentity(entry) === identity,
	);
	if (duplicate) {
		throw new Error(
			`This real account is already logged in as "${duplicate[0]}". Use that slot, or log it out before replacing it.`,
		);
	}
	return credentials;
}

function isEntryUsable(entry: AuthEntry | undefined): boolean {
	if (!entry) return false;
	if (entry.type === "api_key" || entry.key)
		return typeof entry.key === "string" && entry.key.length > 0;
	if (typeof entry.access !== "string" || entry.access.length === 0)
		return false;
	const expMs = oauthExpiryMs(entry);
	if (
		expMs !== undefined &&
		expMs <= Date.now() &&
		!(typeof entry.refresh === "string" && entry.refresh.length > 0)
	) {
		return false;
	}
	return true;
}


const FAMILY_KEYWORDS = new Set([
	"anthropic",
	"claude",
	"codex",
	"openai",
	"cursor",
	"ollama",
	"qwen",
	"alibaba",
]);

function parseFamilyArg(raw: string | undefined): ProviderFamily | undefined {
	const familyRaw = (raw || "").toLowerCase();
	if (familyRaw === "codex" || familyRaw === "openai") return "openai-codex";
	if (familyRaw === "anthropic" || familyRaw === "claude") return "anthropic";
	if (familyRaw === "ollama") return "ollama";
	if (familyRaw === "qwen" || familyRaw === "alibaba") return "qwen";
	if (familyRaw === "cursor") return "cursor";
	if (familyRaw === "kimi" || familyRaw === "kimi-coding") return "kimi-coding";
	return undefined;
}

function isFamilyKeyword(raw: string): boolean {
	return FAMILY_KEYWORDS.has(raw.trim().toLowerCase());
}

function resolveRemoveTarget(
	arg: string,
	auth: Record<string, AuthEntry>,
	qwenProvider: string,
): string | undefined {
	const trimmed = arg.trim();
	if (!trimmed) return undefined;

	if (/-account-\d+$/.test(trimmed) || isCursorProviderId(trimmed)) {
		return auth[trimmed] && classifyProvider(trimmed, qwenProvider)
			? trimmed
			: undefined;
	}

	const parsed = parseTarget(trimmed);
	const exactId = parsed?.provider ?? trimmed;
	if (!isFamilyKeyword(trimmed)) {
		return auth[exactId] && classifyProvider(exactId, qwenProvider)
			? exactId
			: undefined;
	}

	const family = parseFamilyArg(trimmed);
	if (!family) return undefined;

	const aliases = Object.keys(auth)
		.filter(
			(id) =>
				classifyProvider(id, qwenProvider) === family && slotIndex(id) >= 2,
		)
		.sort((a, b) => slotIndex(b) - slotIndex(a));
	if (aliases.length > 0) return aliases[0];

	const baseId = slotId(family, 1, qwenProvider);
	return auth[baseId] ? baseId : undefined;
}

function classifyProvider(
	id: string,
	qwenProvider: string,
): ProviderFamily | undefined {
	if (id === ANTHROPIC_BASE || /^anthropic-account-\d+$/.test(id))
		return "anthropic";
	if (id === CODEX_BASE || /^openai-codex-account-\d+$/.test(id))
		return "openai-codex";
	if (
		id === qwenProvider ||
		new RegExp(`^${escapeRegex(qwenProvider)}-account-\\d+$`).test(id) ||
		/^qwen/i.test(id)
	)
		return "qwen";
	if (
		id === OLLAMA_BASE ||
		/^ollama-account-\d+$/.test(id) ||
		/^ollama/i.test(id)
	)
		return "ollama";
	if (isCursorProviderId(id)) return "cursor";
	if (id === "kimi-coding" || /^kimi-coding-account-\d+$/.test(id))
		return "kimi-coding";
	return undefined;
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slotIndex(id: string): number {
	const m = id.match(/-account-(\d+)$/);
	return m ? Number(m[1]) : 1;
}

function slotId(
	family: ProviderFamily,
	index: number,
	qwenProvider: string = DEFAULT_QWEN_PROVIDER,
): string {
	const base =
		family === "anthropic"
			? ANTHROPIC_BASE
			: family === "openai-codex"
				? CODEX_BASE
				: family === "kimi-coding"
					? "kimi-coding"
					: family === "qwen"
						? qwenProvider
						: family === "cursor"
							? CURSOR_BASE
							: OLLAMA_BASE;
	return index <= 1 ? base : `${base}-account-${index}`;
}

function ref(provider: string, modelId: string): ModelRef {
	return `${provider}/${modelId}` as ModelRef;
}

function parseTarget(
	target: unknown,
): { provider: string; modelId?: string } | undefined {
	if (typeof target !== "string") return undefined;
	const trimmed = target.trim();
	if (!trimmed) return undefined;
	const slash = trimmed.indexOf("/");
	if (slash === -1) return { provider: trimmed };
	const provider = trimmed.slice(0, slash).trim();
	const modelId = trimmed.slice(slash + 1).trim();
	if (!provider || !modelId) return undefined;
	return { provider, modelId };
}

const MODEL_IDENTITY_EFFORTS = new Set([
	"none",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"minimal",
]);

/**
 * Compare models the way a person does: `cursor-grok-4.6-high` is the same model as
 * `cursor-grok-4.6` / `grok-4.6` at a different thinking effort, not a different model.
 */
export function modelIdentityKey(modelId: string): string {
	let id = modelId.trim().toLowerCase();
	if (id.endsWith("-fast")) id = id.slice(0, -5);
	if (id.endsWith("-thinking")) id = id.slice(0, -9);
	const dash = id.lastIndexOf("-");
	if (dash >= 0 && MODEL_IDENTITY_EFFORTS.has(id.slice(dash + 1))) {
		id = id.slice(0, dash);
	}
	if (id.startsWith("cursor-")) id = id.slice("cursor-".length);
	return id;
}

export function sameModelIdentity(
	a: string | undefined,
	b: string | undefined,
): boolean {
	if (!a || !b) return false;
	return a === b || modelIdentityKey(a) === modelIdentityKey(b);
}

type ModelQualityBand = "apex" | "frontier" | "balanced" | "fast";

function baseProviderId(provider: string | undefined): string {
	return String(provider ?? "").toLowerCase().replace(/-account-\d+$/, "");
}

function apexIdentity(modelId: string | undefined): "astra" | "fable" | undefined {
	if (!modelId) return undefined;
	const id = modelId.trim().toLowerCase().replace(/^~/, "");
	if (/(^|[/:-])gpt-6-astra(?:[-/:]|$)/.test(id) || /^gpt-6-astra(?:[-/:]|$)/.test(id)) return "astra";
	if (/(^|[/:-])claude-fable-5(?:[.-]1)?(?:[-/:]|$)/.test(id) || /^claude-fable-5(?:[.-]1)?(?:[-/:]|$)/.test(id)) return "fable";
	return undefined;
}

/** Classify a model into a quality band for automatic routing, or return undefined for unclassified models. */
export function modelQualityBand(modelId: string | undefined, provider?: string): ModelQualityBand | undefined {
	if (!modelId) return undefined;
	const exceptional = apexIdentity(modelId);
	const baseProvider = baseProviderId(provider);
	if (exceptional) {
		if (baseProvider === "cursor") return undefined;
		if (!provider) return "apex";
		if (exceptional === "astra" && (baseProvider === "openai-codex" || baseProvider === "openai")) return "apex";
		if (exceptional === "fable" && (baseProvider === "anthropic" || baseProvider === "openrouter")) return "apex";
		return undefined;
	}
	const id = modelId.trim().toLowerCase().replace(/^cursor-/, "");
	if (/(^|[-/:])(luna|haiku|mini|spark|flash|nano|lite)([-/:]|$)/i.test(id))
		return "fast";
	if (/(^|[-/:])(terra|sonnet|jamba)([-/:]|$)/i.test(id))
		return "balanced";
	if (
		/(^|[-/:])(sol|opus)([-/:]|$)/i.test(id) ||
		/(^|[-/:])composer(?:[-/:]|$)/i.test(id) ||
		/^gpt-5(?:\.\d+)?$/i.test(id) ||
		/(^|[-/:])(?:k3|kimi-k3|grok-4\.6|minimax-m2\.7)([-/:]|$)/i.test(id) ||
		/^glm-5(?:[.:-]|$)/i.test(id) ||
		/qwen.*max/i.test(id)
	)
		return "frontier";
	return undefined;
}

function accountGroup(id: string, qwenProvider: string): string {
	return classifyProvider(id, qwenProvider) ?? id.replace(/-account-\d+$/, "");
}


const FABLE_MODEL_DEFS: Record<string, Record<string, unknown>> = {
	"claude-fable-5": {
		name: "Claude Fable 5",
		thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
		cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	},
	"claude-fable-5-1": {
		name: "Claude Fable 5.1",
		thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
		cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
		compat: { supportsMidConvoEffort: true, forceAdaptiveThinking: true, supportsStrictTools: true },
	},
};

function anthropicModelDef(id: string, providerId: string) {
	const canonical = piAiGetModel("anthropic", id) as any;
	if (canonical) return { ...canonical, provider: providerId };
	const fable = FABLE_MODEL_DEFS[id];
	if (fable) {
		return {
			id,
			api: "anthropic-messages",
			provider: providerId,
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
			...fable,
		};
	}
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: providerId,
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	};
}

function codexModelDef(id: string) {
	return (
		CODEX_MODEL_DEFS[id] ?? {
			id,
			name: id,
			reasoning: true,
			thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
			input: ["text", "image"],
			contextWindow: 272000,
			maxTokens: 128000,
		}
	);
}

/** Merge refreshed OAuth fields, preserving the stored refresh token when no new one is supplied. */
export function mergeRefreshedCredentials(credentials: any, refreshed: any) {
	return {
		...credentials,
		...refreshed,
		refresh:
			typeof refreshed?.refresh === "string" &&
			refreshed.refresh.trim().length > 0
				? refreshed.refresh
				: credentials.refresh,
	};
}

/** Retry a rejected refresh once with the latest stored token. */
export async function refreshWithDiskRetry(opts: {
	credentials: any;
	refresh: (credentials: any) => Promise<any>;
	storedRefresh: () => string | undefined;
}): Promise<any> {
	// external: Anthropic refresh tokens are invalidated on use.
	try {
		return await opts.refresh(opts.credentials);
	} catch (error) {
		const message = String((error as any)?.message ?? error);
		if (!/invalid_grant|refresh_token_reused/i.test(message)) throw error;
		const stored = opts.storedRefresh();
		if (!stored || stored === opts.credentials?.refresh) throw error;
		return await opts.refresh({ ...opts.credentials, refresh: stored });
	}
}

function oauthCredentialChanged(before: any, after: any): boolean {
	return (
		before?.access !== after?.access ||
		before?.refresh !== after?.refresh ||
		before?.expires !== after?.expires ||
		before?.accountId !== after?.accountId
	);
}

/** Refresh and persist an OAuth credential under the storage lock. */
export async function refreshAndPersistWithStorageLock(opts: {
	provider: string;
	credentials: any;
	authStorage: any;
	readLatest: () => any;
	refresh: (credentials: any) => Promise<any>;
	isShadowed?: (stored: any) => boolean;
	persistShadowed?: (credential: any) => void;
	signal?: AbortSignal;
}): Promise<any> {
	if (typeof opts.authStorage?.modify !== "function") {
		throw new Error("OAuth refresh storage does not provide a cross-process modify lock");
	}

	let resolved: any;
	await opts.authStorage.modify(
		opts.provider,
		async (stored: any) => {
			const latest = opts.readLatest();
			if (
				latest?.type !== "oauth" ||
				typeof latest.access !== "string" ||
				typeof latest.refresh !== "string"
			) {
				throw new Error(`No refreshable OAuth credential remains for ${opts.provider}`);
			}

			if (oauthCredentialChanged(opts.credentials, latest)) {
				resolved = latest;
				return undefined;
			}

			resolved = await opts.refresh(latest);
			if (
				resolved?.type !== "oauth" ||
				typeof resolved.access !== "string" ||
				typeof resolved.refresh !== "string"
			) {
				throw new Error(`OAuth refresh returned no usable credential for ${opts.provider}`);
			}

			if (opts.isShadowed?.(stored)) {
				if (!opts.persistShadowed) {
					throw new Error(`No sidecar persistence path exists for ${opts.provider}`);
				}
				opts.persistShadowed(resolved);
				return undefined;
			}
			return resolved;
		},
		{ signal: opts.signal },
	);

	if (!resolved) throw new Error(`OAuth refresh produced no credential for ${opts.provider}`);
	return resolved;
}

function storedRefreshToken(providerId: string): string | undefined {
	const stored = readAuthFile()[providerId] as any;
	return typeof stored?.refresh === "string" && stored.refresh.trim()
		? stored.refresh
		: undefined;
}

function oauthRefreshSignal(signal?: AbortSignal): AbortSignal {
	return signal instanceof AbortSignal ? signal : AbortSignal.timeout(30_000);
}

async function refreshAnthropicCredentials(
	credentials: any,
	signal?: AbortSignal,
	providerId?: string,
) {
	const attempt = (creds: any) =>
		requirePiAiOauth().anthropic.refresh(creds, oauthRefreshSignal(signal));
	if (!providerId)
		return mergeRefreshedCredentials(credentials, await attempt(credentials));
	const refreshed = await refreshWithDiskRetry({
		credentials,
		refresh: attempt,
		storedRefresh: () => storedRefreshToken(providerId),
	});
	return mergeRefreshedCredentials(credentials, refreshed);
}

function anthropicRefresherFor(providerId: string) {
	return (credentials: any, signal?: AbortSignal) =>
		refreshAnthropicCredentials(credentials, signal, providerId);
}

function registerAnthropicSlot(
	pi: ExtensionAPI,
	id: string,
	modelIds: string[] = DEFAULT_ANTHROPIC_MODELS,
	baseUrl = "https://api.anthropic.com",
) {
	if (id === ANTHROPIC_BASE) return;
	registerAnthropicLoginMethods(pi, id, modelIds, baseUrl);
}

function codexOAuthOverride(providerId: string, name: string) {
	const getProvider = () => requirePiAiOauth().codex;
	return {
		name,
		// external: Pi reads this flag while listing providers, before login.
		get usesCallbackServer() {
			return tryLoadPiAiOauth()?.codex.usesCallbackServer ?? true;
		},
		async login(callbacks: any) {
			return rejectDuplicateLogin(providerId, await getProvider().login(callbacks));
		},
		async refreshToken(credentials: any, signal?: AbortSignal) {
			return refreshWithDiskRetry({
				credentials,
				refresh: (current) =>
					getProvider().refresh(current, oauthRefreshSignal(signal)),
				storedRefresh: () => storedRefreshToken(providerId),
			});
		},
		getApiKey(credentials: any) {
			return getProvider().getApiKey(credentials);
		},
	};
}

function registerCodexSlot(
	pi: ExtensionAPI,
	id: string,
	models: Array<Record<string, unknown>> = DEFAULT_CODEX_MODELS.map(codexModelDef),
	baseUrl: string,
) {
	if (id === CODEX_BASE) return;
	pi.registerProvider(id, {
		name: `ChatGPT Plus/Pro (Codex ${id})`,
		baseUrl,
		...(baseUrl.startsWith("http://127.0.0.1:") ? { apiKey: placeholderKeyFor("codex") } : {}),
		api: "openai-codex-responses" as any,
		oauth: codexOAuthOverride(id, `ChatGPT Plus/Pro (Codex ${id})`),
		models: models as any,
	});
}

function registerCodexCatalog(
	pi: ExtensionAPI,
	id: string,
	models: Array<Record<string, unknown>>,
	baseUrl: string,
) {
	const name =
		id === CODEX_BASE
			? "ChatGPT Plus/Pro (Codex)"
			: `ChatGPT Plus/Pro (Codex ${id})`;
	pi.registerProvider(id, {
		name,
		baseUrl,
		// external: Pi replaces provider registrations during catalog refresh.
		...(baseUrl.startsWith("http://127.0.0.1:") ? { apiKey: placeholderKeyFor("codex") } : {}),
		api: "openai-codex-responses" as any,
		oauth: codexOAuthOverride(id, name),
		models: [...models, ...configuredOperationModels(id)] as any,
	});
}


const KIMI_BASE = "kimi-coding";
const KIMI_BASE_URL = "https://api.kimi.com/coding";
// external: Pi ships a bundled kimi-coding catalog.
const DEFAULT_KIMI_MODELS = [
	"k3",
	"k3-256k",
	"kimi-for-coding",
	"kimi-for-coding-highspeed",
];

function kimiModelDef(id: string, providerId: string) {
	const canonical = piAiGetModel(KIMI_BASE, id) as any;
	if (canonical) return { ...canonical, provider: providerId };
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: providerId,
		baseUrl: KIMI_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 32768,
	};
}

function kimiOAuthOverride(providerId: string, name: string) {
	// external: Kimi OAuth requires the pi-ai provider-factories API.
	const getProvider = () => {
		const kimi = requirePiAiOauth().kimi;
		if (!kimi) {
			throw new Error(
				"pi-multi-account: this @earendil-works/pi-ai exposes no Kimi OAuth flow; upgrade pi-ai to log Kimi slots in via subscription.",
			);
		}
		return kimi;
	};
	return {
		name,
		isSubscription: true,
		async login(callbacks: any) {
			return rejectDuplicateLogin(providerId, await getProvider().login(callbacks));
		},
		async refreshToken(credentials: any, signal?: AbortSignal) {
			return getProvider().refresh(credentials, oauthRefreshSignal(signal));
		},
		getApiKey(credentials: any) {
			return credentials.access;
		},
	};
}

function registerKimiSlot(
	pi: ExtensionAPI,
	id: string,
	modelIds: string[] = DEFAULT_KIMI_MODELS,
) {
	if (id === KIMI_BASE) return;
	pi.registerProvider(id, {
		name: `Kimi For Coding (${id})`,
		baseUrl: KIMI_BASE_URL,
		api: "anthropic-messages" as any,
		oauth: kimiOAuthOverride(id, `Kimi For Coding (${id})`),
		models: modelIds.map((m) => kimiModelDef(m, id)) as any,
	});
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const OLLAMA_CLOUD_BASE_URL = "https://ollama.com/v1";

const OLLAMA_MODEL_DEFS: Record<string, Record<string, unknown>> = {
	"glm-5.2:cloud": {
		id: "glm-5.2:cloud",
		name: "GLM-5.2 (Ollama Cloud)",
		contextWindow: 1000000,
		maxTokens: 32768,
		input: ["text"],
		cost: ZERO_COST,
		reasoning: true,
	},
};
function ollamaModelDef(id: string, providerId: string) {
	const def = OLLAMA_MODEL_DEFS[id] ?? {
		id,
		name: id,
		contextWindow: 1000000,
		maxTokens: 32768,
		input: ["text"],
		cost: ZERO_COST,
		reasoning: true,
	};
	return { ...def, provider: providerId, baseUrl: OLLAMA_CLOUD_BASE_URL };
}

// external: Alibaba Model Studio uses a separate OpenAI-compatible international endpoint.
const QWEN_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const QWEN_MODEL_DEFS: Record<string, Record<string, unknown>> = {
	"qwen3.8-max": {
		id: "qwen3.8-max",
		name: "Qwen3.8 Max",
		contextWindow: 1000000,
		maxTokens: 65536,
		input: ["text"],
		cost: ZERO_COST,
		reasoning: true,
		thinkingLevelMap: {
			high: "high",
			low: null,
			medium: null,
			minimal: null,
			xhigh: "max",
		},
	},
	"qwen-max": {
		id: "qwen-max",
		name: "Qwen Max",
		contextWindow: 1000000,
		maxTokens: 8192,
		input: ["text"],
		cost: ZERO_COST,
		reasoning: true,
	},
	"qwen-plus": {
		id: "qwen-plus",
		name: "Qwen Plus",
		contextWindow: 1000000,
		maxTokens: 8192,
		input: ["text"],
		cost: ZERO_COST,
		reasoning: true,
	},
};
function qwenModelDef(id: string, providerId: string) {
	const def = QWEN_MODEL_DEFS[id] ?? {
		id,
		name: id,
		contextWindow: 1000000,
		maxTokens: 8192,
		input: ["text"],
		cost: ZERO_COST,
		reasoning: true,
	};
	return { ...def, provider: providerId };
}

function hostModelIdsFor(ctx: any, baseProvider: string): string[] {
	try {
		const all = ctx?.modelRegistry?.getAll?.() ?? [];
		return all
			.filter((model: any) => model?.provider === baseProvider && typeof model?.id === "string")
			.map((model: any) => model.id);
	} catch {
		return [];
	}
}

function registerApiKeySlot(
	pi: ExtensionAPI,
	id: string,
	family: "ollama" | "qwen",
	qwenBase: string = DEFAULT_QWEN_PROVIDER,
	ctx?: any,
) {
	const baseId = family === "ollama" ? OLLAMA_BASE : qwenBase;
	if (id === baseId) return;
	// external: Pi cannot expose models for an API-key slot without a credential.
	const entry = readAuthFile()[id];
	const key =
		entry && typeof entry.key === "string" && entry.key.length > 0
			? entry.key
			: undefined;
	if (!key) return;
	const baseUrl = family === "ollama" ? OLLAMA_CLOUD_BASE_URL : QWEN_BASE_URL;
	const preferred =
		family === "ollama" ? DEFAULT_OLLAMA_MODELS : DEFAULT_QWEN_MODELS;
	const ids = [...preferred];
	for (const hostId of hostModelIdsFor(ctx, baseId)) {
		if (!ids.includes(hostId)) ids.push(hostId);
	}
	const models = ids.map((m) =>
		family === "ollama" ? ollamaModelDef(m, id) : qwenModelDef(m, id),
	);
	pi.registerProvider(id, {
		name: `${family === "ollama" ? "Ollama" : "Alibaba/Qwen"} (${id})`,
		baseUrl,
		api: "openai-completions" as any,
		apiKey: key,
		...(family === "qwen" ? { streamSimple: qwenPayloadStream } : {}),
		models: models as any,
	});
	return ids;
}


function patternMatch(text: string, patterns: string[]) {
	const lower = text.toLowerCase();
	return patterns.some((p) => p && lower.includes(p.toLowerCase()));
}

function retryAfterToMs(value: string | undefined) {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0)
		return Math.ceil(seconds * 1000);
	const dateMs = Date.parse(value);
	if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
	return undefined;
}

function secondsToMs(value: string | undefined) {
	if (!value) return undefined;
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds >= 0
		? Math.ceil(seconds * 1000)
		: undefined;
}

function unixSecondsToCooldownMs(value: string | undefined) {
	if (!value) return undefined;
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds > 0
		? Math.max(0, seconds * 1000 - Date.now())
		: undefined;
}

function firstDefinedMs(values: Array<number | undefined>) {
	return values.find(
		(value): value is number =>
			value !== undefined && Number.isFinite(value) && value >= 0,
	);
}

function percentValue(value: string | undefined) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : undefined;
}

function cooldownFromHeaders(headers: Record<string, string>) {
	const normalized = new Map(
		Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
	);
	const get = (name: string) => normalized.get(name.toLowerCase());
	const primaryUsed = percentValue(get("x-codex-primary-used-percent"));
	const secondaryUsed = percentValue(get("x-codex-secondary-used-percent"));
	const retryAfter = retryAfterToMs(get("retry-after"));
	const primaryReset = firstDefinedMs([
		secondsToMs(get("x-codex-primary-reset-after-seconds")),
		unixSecondsToCooldownMs(get("x-codex-primary-reset-at")),
	]);
	const secondaryReset = firstDefinedMs([
		secondsToMs(get("x-codex-secondary-reset-after-seconds")),
		unixSecondsToCooldownMs(get("x-codex-secondary-reset-at")),
	]);
	if ((secondaryUsed ?? 0) >= 100)
		return secondaryReset ?? retryAfter ?? primaryReset;
	if ((primaryUsed ?? 0) >= 100)
		return primaryReset ?? retryAfter ?? secondaryReset;
	return retryAfter ?? primaryReset ?? secondaryReset;
}

const RETRY_PHRASE =
	/\btry again in\s*~?\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|[smhd])\b/i;
const RETRY_UNIT_MS: Record<string, number> = {
	s: 1_000,
	sec: 1_000,
	secs: 1_000,
	second: 1_000,
	seconds: 1_000,
	m: 60_000,
	min: 60_000,
	mins: 60_000,
	minute: 60_000,
	minutes: 60_000,
	h: 3_600_000,
	hr: 3_600_000,
	hrs: 3_600_000,
	hour: 3_600_000,
	hours: 3_600_000,
	d: 86_400_000,
	day: 86_400_000,
	days: 86_400_000,
};

// external: Some providers state the recovery horizon in response prose.
function retryPhraseMs(errorText: string): number | undefined {
	const match = errorText.match(RETRY_PHRASE);
	if (!match) return undefined;
	const value = Number(match[1]);
	const unit = RETRY_UNIT_MS[match[2].toLowerCase()];
	if (!Number.isFinite(value) || value <= 0 || !unit) return undefined;
	return Math.round(value * unit);
}

function cooldownFromErrorText(errorText: string) {
	const bodyReset = firstDefinedMs([
		secondsToMs(errorText.match(/"resets_in_seconds"\s*:\s*(\d+)/i)?.[1]),
		unixSecondsToCooldownMs(errorText.match(/"resets_at"\s*:\s*(\d+)/i)?.[1]),
	]);
	if (bodyReset !== undefined) return bodyReset;
	const primaryUsed = percentValue(
		errorText.match(/"X-Codex-Primary-Used-Percent"\s*:\s*"?(\d+)/i)?.[1],
	);
	const secondaryUsed = percentValue(
		errorText.match(/"X-Codex-Secondary-Used-Percent"\s*:\s*"?(\d+)/i)?.[1],
	);
	const primaryReset = firstDefinedMs([
		secondsToMs(
			errorText.match(
				/"X-Codex-Primary-Reset-After-Seconds"\s*:\s*"?(\d+)/i,
			)?.[1],
		),
		unixSecondsToCooldownMs(
			errorText.match(/"X-Codex-Primary-Reset-At"\s*:\s*"?(\d+)/i)?.[1],
		),
	]);
	const secondaryReset = firstDefinedMs([
		secondsToMs(
			errorText.match(
				/"X-Codex-Secondary-Reset-After-Seconds"\s*:\s*"?(\d+)/i,
			)?.[1],
		),
		unixSecondsToCooldownMs(
			errorText.match(/"X-Codex-Secondary-Reset-At"\s*:\s*"?(\d+)/i)?.[1],
		),
	]);
	const stated = retryPhraseMs(errorText);
	if ((secondaryUsed ?? 0) >= 100)
		return secondaryReset ?? primaryReset ?? stated;
	if ((primaryUsed ?? 0) >= 100) return primaryReset ?? secondaryReset ?? stated;
	return primaryReset ?? secondaryReset ?? stated;
}

function cooldownMsFromUsage(
	snapshot: UsageSnapshot,
	now = Date.now(),
): number | undefined {
	// external: A longer Codex or Claude rolling window can be exhausted while the short window has headroom.
	if (snapshot.primary && snapshot.primary.usedPercent < 100) return 0;

	// external: Cursor extra Grok Bot quota is separate from the main subscription pool.
	const windows = [snapshot.primary, snapshot.secondary].filter(
		(w): w is UsageWindow => !!w,
	);
	if (windows.length === 0) return undefined;
	const blocking = windows.filter(
		(w) => w.usedPercent >= 100 && w.resetAt > now,
	);
	if (blocking.length === 0) return 0;
	return Math.min(...blocking.map((w) => w.resetAt)) - now;
}

function formatUntil(timestamp: number) {
	const ms = timestamp - Date.now();
	if (ms <= 0) return "expired";
	const minutes = Math.ceil(ms / 60000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function formatDelay(ms: number): string {
	if (ms < 60_000) return `${Math.ceil(ms / 1000)}s`;
	const totalMinutes = Math.ceil(ms / 60_000);
	if (totalMinutes < 60) return `${totalMinutes}m`;
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

function lastAssistantStopReason(messages: any[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "assistant")
			return messages[i]?.stopReason as string | undefined;
	}
	return undefined;
}

// external: Portado de Anthropic OAuth: Claude Code version drift may cause rejected or miscounted OAuth requests.

const PI_DEFAULT_PROMPT_PREFIX =
	"You are an expert coding assistant operating inside pi, a coding agent harness.";
const PI_DEFAULT_PROMPT_TERMINATOR =
	"- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)";
const MINIMAL_ANTHROPIC_OAUTH_PROMPT_PREFIX =
	"You are an expert coding assistant.";
const MINIMAL_ANTHROPIC_OAUTH_PROMPT = [
	MINIMAL_ANTHROPIC_OAUTH_PROMPT_PREFIX,
	"Be concise and helpful.",
	"Use the available tools to answer the user's request.",
	"Show file paths clearly when working with files.",
].join("\n");
const CLAUDE_CODE_IDENTITY_PREFIX =
	"You are Claude Code, Anthropic's official CLI";
const CLAUDE_CODE_VERSION = "2.1.288";
const BILLING_HEADER_SALT = "59cf53e54c78";
const BILLING_HEADER_POSITIONS = [4, 7, 20] as const;
const CLAUDE_CODE_ENTRYPOINT = "sdk-cli";
const PARAGRAPH_REMOVAL_ANCHORS: readonly string[] = [
	"operating inside pi, a coding agent harness",
	"In addition to the tools above",
	"Pi documentation (read only when the user asks about pi itself",
];
const TEXT_REPLACEMENTS: readonly { match: string; replacement: string }[] = [
	{
		match:
			"Here is some useful information about the environment you are running in:",
		replacement: "Environment context you are running in:",
	},
];

type ShapeTextBlock = { type: "text"; text: string; [key: string]: unknown };
type ShapeMessageBlock = {
	type?: string;
	text?: string;
	[key: string]: unknown;
};
type ShapeMessageParam = {
	role?: string;
	content?: string | ShapeMessageBlock[];
	[key: string]: unknown;
};
type ShapeAnthropicPayload = {
	model?: unknown;
	messages?: unknown;
	system?: unknown;
	stream?: unknown;
	[key: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAnthropicMessagesPayload(
	payload: unknown,
): payload is ShapeAnthropicPayload {
	return (
		isRecord(payload) &&
		typeof payload.model === "string" &&
		Array.isArray(payload.messages) &&
		typeof payload.stream === "boolean"
	);
}

function hasOAuthAnthropicSystemMarker(block: unknown): boolean {
	if (
		!isRecord(block) ||
		block.type !== "text" ||
		typeof block.text !== "string"
	)
		return false;
	return (
		block.text.includes(CLAUDE_CODE_IDENTITY_PREFIX) ||
		block.text.includes("x-anthropic-billing-header:") ||
		block.text.startsWith(MINIMAL_ANTHROPIC_OAUTH_PROMPT_PREFIX)
	);
}

function isOAuthAnthropicPayload(payload: ShapeAnthropicPayload): boolean {
	if (!Array.isArray(payload.system)) return false;
	return payload.system.some(hasOAuthAnthropicSystemMarker);
}

function getFirstUserText(messages: ShapeMessageParam[]): string {
	const firstUserMessage = messages.find((message) => message.role === "user");
	if (!firstUserMessage) return "";
	if (typeof firstUserMessage.content === "string")
		return firstUserMessage.content;
	if (!Array.isArray(firstUserMessage.content)) return "";
	const firstTextBlock = firstUserMessage.content.find(
		(block) => block.type === "text" && typeof block.text === "string",
	);
	return typeof firstTextBlock?.text === "string" ? firstTextBlock.text : "";
}

function buildBillingHeaderValue(
	messages: ShapeMessageParam[],
): string | undefined {
	const messageText = getFirstUserText(messages);
	if (!messageText) return undefined;
	const cch = createHash("sha256")
		.update(messageText)
		.digest("hex")
		.slice(0, 5);
	const sampledCharacters = BILLING_HEADER_POSITIONS.map(
		(index) => messageText[index] || "0",
	).join("");
	const suffix = createHash("sha256")
		.update(`${BILLING_HEADER_SALT}${sampledCharacters}${CLAUDE_CODE_VERSION}`)
		.digest("hex")
		.slice(0, 3);
	return [
		"x-anthropic-billing-header:",
		`cc_version=${CLAUDE_CODE_VERSION}.${suffix};`,
		`cc_entrypoint=${CLAUDE_CODE_ENTRYPOINT};`,
		`cch=${cch};`,
	].join(" ");
}

function normalizeSystemBlock(block: unknown): ShapeTextBlock {
	if (typeof block === "string") return { type: "text", text: block };
	if (isRecord(block) && typeof block.text === "string")
		return { ...block, type: "text", text: block.text };
	return { type: "text", text: "" };
}

function prependBillingHeader(
	system: unknown,
	messages: ShapeMessageParam[],
): unknown {
	const billingHeader = buildBillingHeaderValue(messages);
	if (!billingHeader) return system;
	const systemBlocks = Array.isArray(system)
		? system.map(normalizeSystemBlock)
		: system == null
			? []
			: [normalizeSystemBlock(system)];
	if (
		systemBlocks.some((block) =>
			block.text.includes("x-anthropic-billing-header:"),
		)
	)
		return systemBlocks;
	const billingBlock: ShapeTextBlock = { type: "text", text: billingHeader };
	return [billingBlock, ...systemBlocks];
}

// external: Portado de Anthropic OAuth: Anthropic rejects non-tool_use blocks after tool_use in assistant turns.
function splitAssistantToolUseTrailingContent(
	messages: ShapeMessageParam[],
): ShapeMessageParam[] {
	return messages.flatMap((message) => {
		if (message.role !== "assistant" || !Array.isArray(message.content))
			return [message];
		const firstToolUseIndex = message.content.findIndex(
			(block) => block.type === "tool_use",
		);
		if (firstToolUseIndex === -1) return [message];
		const trailingBlocks = message.content.slice(firstToolUseIndex);
		if (!trailingBlocks.some((block) => block.type !== "tool_use"))
			return [message];
		const nonToolUseBlocks = message.content.filter(
			(block) => block.type !== "tool_use",
		);
		const toolUseBlocks = message.content.filter(
			(block) => block.type === "tool_use",
		);
		return [
			{ ...message, content: nonToolUseBlocks },
			{ ...message, content: toolUseBlocks },
		];
	});
}

function sanitizeSystemText(text: string): string {
	const paragraphs = text.split(/\n\n+/);
	const filtered = paragraphs.filter(
		(paragraph) =>
			!PARAGRAPH_REMOVAL_ANCHORS.some((anchor) => paragraph.includes(anchor)),
	);
	let result = filtered.join("\n\n");
	for (const rule of TEXT_REPLACEMENTS)
		result = result.replaceAll(rule.match, rule.replacement);
	return result.trim();
}

function findProjectContextStart(systemPrompt: string): number {
	return systemPrompt.indexOf("\n\n# Project Context\n\n");
}

function shapeAnthropicOAuthSystemPrompt(systemPrompt: string): string {
	const prefixIdx = systemPrompt.indexOf(PI_DEFAULT_PROMPT_PREFIX);
	if (prefixIdx === -1) return systemPrompt;
	const terminatorIdx = systemPrompt.indexOf(
		PI_DEFAULT_PROMPT_TERMINATOR,
		prefixIdx,
	);
	if (terminatorIdx !== -1) {
		const terminatorEnd = terminatorIdx + PI_DEFAULT_PROMPT_TERMINATOR.length;
		const preamble = systemPrompt.slice(prefixIdx, terminatorEnd);
		const sanitized = sanitizeSystemText(preamble);
		const shapedPreamble = sanitized
			? `${MINIMAL_ANTHROPIC_OAUTH_PROMPT}\n\n${sanitized}`
			: MINIMAL_ANTHROPIC_OAUTH_PROMPT;
		return (
			systemPrompt.slice(0, prefixIdx) +
			shapedPreamble +
			systemPrompt.slice(terminatorEnd)
		);
	}
	const projectContextStart = findProjectContextStart(systemPrompt);
	if (projectContextStart === -1) return MINIMAL_ANTHROPIC_OAUTH_PROMPT;
	return `${MINIMAL_ANTHROPIC_OAUTH_PROMPT}${systemPrompt.slice(projectContextStart)}`;
}

function shapeSystemBlocks(blocks: ShapeTextBlock[]): ShapeTextBlock[] {
	return blocks.map((block) => {
		if (block.type !== "text" || !block.text.includes(PI_DEFAULT_PROMPT_PREFIX))
			return block;
		return { ...block, text: shapeAnthropicOAuthSystemPrompt(block.text) };
	});
}

function shapeAnthropicOAuthPayload(payload: unknown): unknown {
	if (!isAnthropicMessagesPayload(payload)) return payload;
	const messages = payload.messages as ShapeMessageParam[];
	if (!isOAuthAnthropicPayload(payload)) return payload;
	const normalizedMessages = splitAssistantToolUseTrailingContent(messages);
	const shapedSystem = Array.isArray(payload.system)
		? shapeSystemBlocks(payload.system as ShapeTextBlock[])
		: payload.system;
	const finalSystem = prependBillingHeader(shapedSystem, normalizedMessages);
	return { ...payload, messages: normalizedMessages, system: finalSystem };
}

// external: Qwen uses system messages rather than the OpenAI developer role.
function rewriteDeveloperRoleToSystem(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") return false;
	const messages = (payload as { messages?: unknown }).messages;
	if (!Array.isArray(messages)) return false;
	let changed = false;
	for (const message of messages) {
		if (
			message &&
			typeof message === "object" &&
			(message as { role?: unknown }).role === "developer"
		) {
			(message as { role?: unknown }).role = "system";
			changed = true;
		}
	}
	return changed;
}

const anthropicPayloadStream = createPayloadStream((payload) => shapeAnthropicOAuthPayload(payload));
const qwenPayloadStream = createPayloadStream((payload) => {
	rewriteDeveloperRoleToSystem(payload);
	return payload;
});

function readAnthropicLoginCredential(id: string): AuthEntry | undefined {
	const entry = readAuthFile()[id];
	return isChildFacingPlaceholderForSlot(entry, id) ? undefined : entry;
}

function registerAnthropicLoginMethods(
	pi: ExtensionAPI,
	id: string,
	modelIds?: string[],
	baseUrl = "https://api.anthropic.com",
): void {
	const base = builtinProviders().find((provider) => provider.id === ANTHROPIC_BASE);
	if (!base) throw new Error("The running Pi host has no Anthropic provider");
	const models = modelIds
		? () => modelIds.map((modelId) => ({ ...anthropicModelDef(modelId, id), provider: id, baseUrl, api: "anthropic-messages" } as any))
		: undefined;
	const provider = anthropicLoginProvider(base, id, readAnthropicLoginCredential, models);
	const oauth = provider.auth.oauth!;
	// external: Pi discards a native provider registration when it is replaced by legacy string/config registration.
	pi.registerProvider({
		...provider,
		baseUrl,
		streamSimple: anthropicPayloadStream,
		auth: {
			...provider.auth,
			oauth: {
				...oauth,
				login: async (...args: Parameters<typeof oauth.login>) => rejectDuplicateLogin(id, await oauth.login(...args)),
				refresh: anthropicRefresherFor(id),
			},
		},
	});
}


export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";

// external: pi-subagents owns model selection and fallback routing in its child processes.
export function isSubagentChildProcess(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return env[SUBAGENT_CHILD_ENV] === "1";
}

function parseExplicitCliArgs(argv: readonly string[] = process.argv): {
	model?: string;
	provider?: string;
	thinking?: ReasoningLevel;
} {
	let model: string | undefined;
	let provider: string | undefined;
	let thinking: ReasoningLevel | undefined;
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") break;
		if (arg === "--provider" && i + 1 < argv.length) provider = argv[++i];
		else if (arg === "--model" && i + 1 < argv.length) model = argv[++i];
		else if (arg === "--thinking" && i + 1 < argv.length) {
			const value = argv[++i];
			if (REASONING_LEVELS.includes(value as ReasoningLevel)) {
				thinking = value as ReasoningLevel;
			}
		}
	}
	return { model, provider, thinking };
}

async function resolveExplicitCliModelThinkingLevel(
	args: ReturnType<typeof parseExplicitCliArgs>,
	ctx: any,
): Promise<ReasoningLevel | undefined> {
	if (!args.model) return undefined;
	try {
		const registry = ctx?.modelRegistry;
		const models = registry?.getAll?.() ?? [];
		const { resolveCliModel } = await import(
			"@earendil-works/pi-coding-agent"
		);
		const { thinkingLevel } = resolveCliModel({
			cliProvider: args.provider,
			cliModel: args.model,
			cliThinking: args.thinking,
			modelRuntime: {
				getModels: () => models,
				hasConfiguredAuth: (provider: string) =>
					models.some(
						(model: any) =>
							model.provider === provider &&
							(registry.hasConfiguredAuth?.(model) ??
								registry.getProviderAuthStatus?.(provider)?.configured ??
								false),
					),
			} as any,
		});
		return REASONING_LEVELS.includes(thinkingLevel as ReasoningLevel)
			? (thinkingLevel as ReasoningLevel)
			: undefined;
	} catch {
		return undefined;
	}
}

export function explicitCliSelections(
	argv: readonly string[] = process.argv,
): { model: boolean; thinking: boolean } {
	const parsed = parseExplicitCliArgs(argv);
	return {
		model: parsed.model !== undefined,
		thinking: parsed.thinking !== undefined,
	};
}

interface HostCompletionRouter {
	select(request: RouteRequestFact): RouteDecision | Promise<RouteDecision>;
	onAttempt?(attempt: RouteAttemptFact): void | Promise<void>;
}

const MODEL_ROUTE_REQUEST_EVENT = "pi:model-route:request:v1";
type ModelRouteRequest = {
	version: 1;
	purpose?: string;
	model: RouteModelRef;
	result?:
		| { action: "keep"; reason?: string }
		| { action: "route"; model: RouteModelRef; reason: string };
};

interface HostCompletionRouterAPI {
	registerCompletionRouter?(router: HostCompletionRouter): void;
	unregisterCompletionRouter?(): void;
}

export default function piMultiAccount(pi: ExtensionAPI) {
	const oauthUnavailable = piAiOauthUnavailableReason();
	let subagentChild = isSubagentChildProcess();
	let hostOwnsSessionModel = false;
	let startupModel: { provider: string; id: string } | undefined;
	const activationKey = Symbol.for("pi-multi-account:active-root-session");
	const activations = globalThis as typeof globalThis & {
		[activationKey]?: { owner: object; sessionId?: string; relinquish: () => void };
	};
	const activationOwner = {};
	type SharedProxyMember = {
		sessionId?: string;
		ready: boolean;
		proxyEnabled: boolean;
		prepareRoutes: (slotIds: readonly string[], port: number) => boolean;
		relinquish: () => void;
		handleRequest: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
	};
	type SharedProxyCoordinator = {
		members: Map<object, SharedProxyMember>;
		routes: Map<string, ProxyRoute>;
		sessionOwners: Map<string, object>;
		server?: Server;
		starting?: Promise<number | undefined>;
		publisher?: object;
		handlerOwner?: object;
		handoffUntil?: number;
		handoffTimer?: ReturnType<typeof setTimeout>;
	};
	const coordinatorKey = Symbol.for("pi-multi-account:shared-slot-proxy-coordinators");
	const coordinatorGlobals = globalThis as typeof globalThis & {
		[coordinatorKey]?: Map<number, SharedProxyCoordinator>;
	};
	const coordinators = coordinatorGlobals[coordinatorKey] ??= new Map<number, SharedProxyCoordinator>();
	let slotProxyCoordinator: SharedProxyCoordinator | undefined;
	// external: pi-web hosts multiple independent root sessions in one process.
	const multiSessionHost =
		process.env.PI_WEB_SESSION === "1" ||
		process.env.PI_MULTI_ACCOUNT_INDEPENDENT_ROOTS === "1";
	const explicitCliArgs = parseExplicitCliArgs();
	const explicitCli = {
		model: explicitCliArgs.model !== undefined,
		thinking: explicitCliArgs.thinking !== undefined,
	};
	const explicitCliThinkingAtRegistration = explicitCliArgs.thinking;
	const hasExplicitCliSelection = explicitCli.model || explicitCli.thinking;
	let modelPreferenceChanged = !hasExplicitCliSelection;
	let thinkingPreferenceChanged = !hasExplicitCliSelection;
	const sessionInstanceId = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
	const recoveryArbiter = new AutomaticRecoveryArbiter((metadata) =>
		pi.events.emit("optchat:recovery", metadata),
	);
	function recoverySessionId(ctx: any): string | undefined {
		try {
			const id = ctx?.sessionManager?.getSessionId?.();
			return typeof id === "string" && id.length > 0 ? id : undefined;
		} catch {
			return undefined;
		}
	}
	let config = loadConfig();
	let sessionClosed = false;
	const pendingNativePublications = new Set<Promise<void>>();
	let supersededRoot = false;
	let manualRouteOwnsErrors = false;
	const automaticFailoverEnabled = () => config.enabled && !subagentChild && !sessionClosed;
	debugLogEnabled = config.debugLog;
	let configuredFallbacks = config.fallbacks.slice();
	let persistedState = loadState();
	let lastSavedState = structuredClone(persistedState);
	let lastModelByFamily: Record<string, string> = {
		...(persistedState.lastModelByFamily ?? {}),
	};
	// external: Pi awaits the extension factory before restoring its selected model.
	let cursorReady: Promise<unknown> | undefined;

	let onlyActiveModels = config.onlyActive;
	const hiddenProviderModels = new Map<string, any[]>();

	function unhideProvider(provider: string) {
		const models = hiddenProviderModels.get(provider);
		if (!models) return;
		try {
			pi.registerProvider(provider, { models } as any);
			hiddenProviderModels.delete(provider);
		} catch (error) {
			logEvent("only_active_restore_failed", {
				provider,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}

	function clearOnlyActiveFilter() {
		for (const provider of [...hiddenProviderModels.keys()]) unhideProvider(provider);
	}

	function applyOnlyActiveFilter(_ctx: any, _activeProvider?: string) {
		// external: Pi shares one model registry across clients.
		clearOnlyActiveFilter();
	}

	let internalModelChanges = 0;
	async function setModelEnsuringVisible(
		target: { provider: string; id: string },
		_ctx: any,
	) {
		if (onlyActiveModels) unhideProvider(target.provider);
		// external: Pi versions through 0.84.2 persist the selected model as the global default.
		pendingSettingsCheck = piAutoPersistsSelectedModel(PI_HOST_VERSION);
		internalModelChanges++;
		try {
			return await pi.setModel(target as any);
		} finally {
			internalModelChanges--;
		}
	}

	function findModelIncludingHidden(ctx: any, provider: string, modelId: string) {
		const direct =
			ctx.modelRegistry.find(provider, modelId) ??
			hiddenProviderModels.get(provider)?.find((m: any) => m.id === modelId);
		if (direct) return direct;
		try {
			const fromRegistry = (ctx.modelRegistry.getAll?.() ?? []).filter(
				(m: any) => m.provider === provider,
			);
			const pool = [
				...fromRegistry,
				...(hiddenProviderModels.get(provider) ?? []),
			];
			const exact = pool.find((m: any) => m.id === modelId);
			if (exact) return exact;
			// external: Cursor catalogs include reasoning-effort suffixes on model ids.
			return pool.find((m: any) => sameModelIdentity(m.id, modelId));
		} catch {
			return undefined;
		}
	}

	const clampCooldownUntil = (until: number, now = Date.now()): number =>
		Number.isFinite(until) ? Math.min(until, now + MAX_LIVE_COOLDOWN_MS) : until;
	const exhaustedUntilByProvider = new Map<string, number>(
		Object.entries(persistedState.exhaustedUntilByProvider ?? {}).map(
			([provider, until]) => [provider, clampCooldownUntil(until)],
		),
	);
	const exhaustedUntilByModel = new Map<string, number>(
		Object.entries(persistedState.exhaustedUntilByModel ?? {}),
	);
	const invalidatedByProvider = new Map<string, InvalidationRecord>(
		Object.entries(persistedState.invalidatedByProvider ?? {}),
	);
	const usageByProvider = new Map<string, UsageSnapshot>(
		Object.entries(persistedState.usageByProvider ?? {}),
	);
	const codexModelCatalogByProvider = new Map<string, CodexCatalogSnapshot>(
		Object.entries(persistedState.codexModelCatalogByProvider ?? {}),
	);
	const authTypeByProvider = new Map<string, "oauth" | "api_key">(
		Object.entries(persistedState.authTypeByProvider ?? {}).filter(
			(entry): entry is [string, "oauth" | "api_key"] =>
				entry[1] === "oauth" || entry[1] === "api_key",
		),
	);
	const authTypeOfEntry = (entry: AuthEntry | undefined): "oauth" | "api_key" | undefined =>
		entry?.type === "oauth" ? "oauth" : entry?.type === "api_key" ? "api_key" : undefined;
	const usageFetches = new Map<string, Promise<UsageSnapshot>>();
	const usageErrors = new Map<string, string>();
	const authFailures = new Map<string, { hash: string; distinct: number }>();
	const responseCooldownHints = new Map<string, number>();
	const handledAssistantErrors = new Set<string>();
	const limitStreakByProvider = new Map<
		string,
		{ count: number; lastAt: number }
	>();
	const usageUntrustedUntilByProvider = new Map<string, number>(
		Object.entries(persistedState.usageUntrustedUntilByProvider ?? {}).filter(
			([, until]) => typeof until === "number" && until > Date.now(),
		),
	);

	let manualPinnedProvider: string | undefined;
	let manualPinCoveredMessage = false;

	function pinManualChoice(provider: string | undefined) {
		manualPinnedProvider = provider;
		manualPinCoveredMessage = false;
	}

	function retireSpentManualPin() {
		if (manualPinCoveredMessage) manualPinnedProvider = undefined;
	}

	function hasManualPin(provider: string | undefined): boolean {
		return !!provider && manualPinnedProvider === provider;
	}

	function markManualPinUsed(provider: string | undefined) {
		if (hasManualPin(provider)) manualPinCoveredMessage = true;
	}

	let failoverPinnedProvider: string | undefined;
	let failoverPinCoveredMessage = false;

	function pinFailoverProbe(provider: string | undefined) {
		failoverPinnedProvider = provider;
		failoverPinCoveredMessage = true;
	}

	function retireSpentFailoverPin() {
		if (failoverPinCoveredMessage) failoverPinnedProvider = undefined;
	}

	function hasFailoverPin(provider: string | undefined): boolean {
		return !!provider && failoverPinnedProvider === provider;
	}

	function markFailoverPinUsed(provider: string | undefined) {
		if (hasFailoverPin(provider)) failoverPinCoveredMessage = true;
	}

	let rotation: string[] = [];
	let duplicateSlots: Array<{ duplicate: string; primary: string }> = [];
	let preflightNotified = false;
	const registeredSlots = new Set<string>();
	const apiKeySlotHostSignature = new Map<string, string>();
	let cursorSetupFailureNotified = false;
	let discoveredCodexModelOrder: string[] = [];
	let registryCodexModelOrder: string[] = [];
	// external: Anthropic does not provide a per-account model catalog API.
	let registryAnthropicModelOrder: string[] = [];
	// external: Ollama Cloud exposes a live model catalog at /v1/models.
	let discoveredOllamaModelIds: string[] = [];
	let ollamaCatalogFetchedAt = 0;
	let lastAuthMtime = -1;
	const credentialHashes = new Map<string, string>();
	const credentialIdentities = new Map<string, string>();

	let currentPromptSwitch: SwitchRecord | undefined;
	let continuationRecoveryLease: AutomaticRecoveryLease | undefined;
	let contextGuardRecoveryLease: AutomaticRecoveryLease | undefined;
	let contextGuardRecoveryEpoch: number | undefined;
	let autoContinuesThisPrompt = 0;
	let pendingResumeHops = 0;
	let pendingWakeBackoffMs = MIN_PENDING_WAKE_MS;
	let queuedWakeBackoffMs = AUTH_CHANGE_POLL_MS;
	let chainEpoch = 0;
	let pendingWakeTimer: ReturnType<typeof setTimeout> | undefined;
	let queuedInputWakeTimer: ReturnType<typeof setTimeout> | undefined;
	let usageStatusTimer: ReturnType<typeof setInterval> | undefined;
	let usageTelemetryUnsaved = false;
	type PendingResumeMode = "auto-continue" | "quota-recovery";
	let pendingResume:
		| {
				from: ModelRef;
				reason: string;
				since: number;
				retryAt?: number;
				mode: PendingResumeMode;
			}
		| undefined;

	const GOVERNOR_ACTIONS_WITHOUT_REQUEST = 12;
	const GOVERNOR_ACTIONS_WITHOUT_SUCCESS = 40;
	let actionsSinceRequest = 0;
	let actionsSinceSuccess = 0;
	let firstActionSinceRequestAt = 0;
	let governorStoppedReason: string | undefined;
	let requestSignalSeen = false;
	let successSignalSeen = false;

	const queuedUserInputs: Array<{ text: string; images?: any[] }> = [];
	let continuationDispatchedForAgentTurn = false;
	let userAbortedChain = false;
	let lastLeftProvider: string | undefined;
	let lastLeftAt = 0;
	type ThinkingChangeEvidence = {
		model: string;
		previousLevel: ReasoningLevel;
		appliedLevel: ReasoningLevel;
	};
	let automaticModelTarget: ModelRef | undefined;
	let automaticWarmupTarget: ModelRef | undefined;
	let pendingWarmupUpgrade:
		| { provider: string; warmupId: string; target: { provider: string; id: string } }
		| undefined;
	let lastObservedModelKey: string | undefined;
	let lastObservedThinkingLevel: ReasoningLevel | undefined;
	let pendingModelThinkingChange: ThinkingChangeEvidence | undefined;
	let activeResumeWatch: symbol | undefined;
	let progressWatchdogTimer: ReturnType<typeof setTimeout> | undefined;
	let watchdogCtx: any;
	let lastResumeProgressAt = 0;
	let stuckReminders = 0;
	// external: Pi versions through 0.84.2 persist model switches as the global default.
	let pendingSettingsCheck = false;
	let contractDriftAnnounced = false;
	let lastContractVerdicts: ShapeVerdict[] = [];

	let watchdogAborting = false;
	let userPromptStartsTurn = false;
	let exhaustedGateAborting = false;
	let exhaustedGateNoticeKey: string | undefined;
	let toolInFlight = 0;
	let expectingInjectedContinuation = false;
	let lastContextOverflowAt = 0;
	let compactionRoutedNote: string | undefined;
	let recoveryFailures = 0;
	let breakerOpenUntil = 0;
	// external: Pi owns an agent-level retry loop separate from extension recovery.
	let transientFailureStreak:
		| { route: ModelRef; count: number }
		| undefined;
	const cursorStallFailuresByRoute = new Map<
		ModelRef,
		{ provider: string; count: number }
	>();
	// external: Pi clamps thinking levels to the selected model capabilities.
	let desiredThinkingLevel: ReasoningLevel | undefined =
		explicitCliThinkingAtRegistration;
	let explicitCliThinkingLevel: ReasoningLevel | undefined = explicitCliThinkingAtRegistration;
	let thinkingClamp: { model: string; level: ReasoningLevel } | undefined;
	const thinkingChangeSource = new AsyncLocalStorage<"extension">();

	const thinkingRank = (level: unknown) =>
		REASONING_LEVELS.indexOf(level as ReasoningLevel);

	function readThinkingLevel(): ReasoningLevel | undefined {
		try {
			const level = (pi as any).getThinkingLevel?.();
			return thinkingRank(level) >= 0 ? (level as ReasoningLevel) : undefined;
		} catch {
			// external: Older Pi hosts do not expose getThinkingLevel.
			return undefined;
		}
	}

	if (explicitCli.thinking && !explicitCliThinkingLevel)
		explicitCliThinkingLevel = readThinkingLevel();
	if (explicitCli.thinking && explicitCliThinkingLevel)
		desiredThinkingLevel = explicitCliThinkingLevel;

	const thinkingModelKey = (ctx?: any) =>
		ctx?.model?.provider && ctx?.model?.id
			? ref(ctx.model.provider, ctx.model.id)
			: "unknown";

	function isKnownThinkingClamp(ctx: any, level: ReasoningLevel) {
		return (
			!!thinkingClamp &&
			thinkingClamp.level === level &&
			thinkingClamp.model === thinkingModelKey(ctx) &&
			level !== desiredThinkingLevel
		);
	}

	function captureDesiredThinking(ctx?: any) {
		const forced =
			config.reasoningLevel === "auto" ? undefined : config.reasoningLevel;
		if (forced) {
			desiredThinkingLevel = forced;
		} else {
			const actual = readThinkingLevel();
			if (!actual) {
			} else if (desiredThinkingLevel === undefined) {
				const remembered = persistedState.lastUserThinkingLevel;
				const rememberedLevel =
					thinkingRank(remembered) >= 0
						? (remembered as ReasoningLevel)
						: undefined;
				desiredThinkingLevel = hostOwnsSessionModel ? actual : rememberedLevel ?? actual;
				if (desiredThinkingLevel !== actual) {
					logEvent("thinking_intent_recovered", {
						observed: actual,
						restored: desiredThinkingLevel,
					});
				}
			} else if (
				actual !== desiredThinkingLevel &&
				!isKnownThinkingClamp(ctx, actual)
			) {
				logEvent("thinking_intent", { from: desiredThinkingLevel, to: actual });
				desiredThinkingLevel = actual;
			}
		}
		restoreDesiredThinking(ctx);
	}

	function restoreDesiredThinking(ctx?: any) {
		if (!desiredThinkingLevel) return;
		try {
			thinkingChangeSource.run("extension", () =>
				(pi as any).setThinkingLevel?.(desiredThinkingLevel),
			);
		} catch {
			// external: Pi clamps thinking levels to model capabilities.
		}
		const applied = readThinkingLevel();
		if (!applied) return;
		lastObservedThinkingLevel = applied;
		if (applied !== desiredThinkingLevel) {
			thinkingClamp = { model: thinkingModelKey(ctx), level: applied };
			logEvent("thinking_clamped", {
				wanted: desiredThinkingLevel,
				applied,
				model: thinkingClamp.model,
			});
		} else {
			thinkingClamp = undefined;
		}
	}

	const reportedErrors = new Map<string, number>();
	function reportExtensionError(where: string, error: unknown, ctx?: any) {
		const msg = error instanceof Error ? error.message : String(error);
		const key = `${where}:${msg.slice(0, 80)}`;
		const now = Date.now();
		const last = reportedErrors.get(key) ?? 0;
		logEvent("internal_error", { where, error: msg });
		if (now - last < 30_000) return;
		reportedErrors.set(key, now);
		if (reportedErrors.size > 50) reportedErrors.clear();
		try {
			ctx?.ui?.notify?.(
				`pi-multi-account: recovered from an internal error in ${where} (${msg.slice(0, 140)}). Failover continues; run /multi-account status if anything looks off.`,
				"warning",
			);
		} catch {
		}
	}

	function checkPiContract(ctx: any, why: string, includeSettings = false) {
		const active =
			includeSettings && ctx?.model?.provider && ctx?.model?.id
				? { provider: ctx.model.provider as string, id: ctx.model.id as string }
				: undefined;
		const verdicts = inspectPiContract(active);
		lastContractVerdicts = verdicts;
		const drift = describeContractDrift(verdicts);
		if (drift || why === "session_start") {
			logEvent("pi_contract_checked", {
				why,
				checked: verdicts.map((verdict) => verdict.file),
				problems: verdicts.flatMap((verdict) => verdict.problems),
				unpromised: observedAssumptions().map((assumption) => assumption.id),
			});
		}
		if (!drift) {
			contractDriftAnnounced = false;
			return;
		}
		if (contractDriftAnnounced) return;
		contractDriftAnnounced = true;
		ctx?.ui?.notify?.(drift, "warning");
	}

	function safeOn(event: string, handler: (ev: any, ctx: any) => any) {
		pi.on(event as any, (ev: any, ctx: any) => {
			try {
				const out = handler(ev, ctx);
				if (out && typeof (out as any).then === "function") {
					return (out as Promise<unknown>).catch((error) => {
						reportExtensionError(`${event} handler`, error, ctx);
						return undefined;
					});
				}
				return out;
			} catch (error) {
				reportExtensionError(`${event} handler`, error, ctx);
				return undefined;
			}
		});
	}

	function runBackground(where: string, ctx: any, fn: () => Promise<unknown>) {
		try {
			void fn().catch((error) => reportExtensionError(where, error, ctx));
		} catch (error) {
			reportExtensionError(where, error, ctx);
		}
	}

	function persist(
		extra?: Partial<ProviderFailoverState>,
		options: {
			clearPending?: "owned" | "owned-or-legacy";
			writeUserPreferences?: boolean;
		} = {},
	) {
		let next: ProviderFailoverState = {
			...persistedState,
			...extra,
			stateVersion: STATE_VERSION,
			exhaustedUntilByProvider: Object.fromEntries(
				exhaustedUntilByProvider.entries(),
			),
			exhaustedUntilByModel: Object.fromEntries(
				exhaustedUntilByModel.entries(),
			),
			invalidatedByProvider: Object.fromEntries(
				invalidatedByProvider.entries(),
			),
			usageUntrustedUntilByProvider: Object.fromEntries(
				usageUntrustedUntilByProvider.entries(),
			),
			usageByProvider: Object.fromEntries(usageByProvider.entries()),
			codexModelCatalogByProvider: Object.fromEntries(
				codexModelCatalogByProvider.entries(),
			),
			authTypeByProvider: Object.fromEntries(authTypeByProvider.entries()),
		};
		// external: Pi windows and delegated children can share the same state file.
		try {
			next = mutateStateFile<ProviderFailoverState>(STATE_PATH, (disk) => {
				next = mergeStateDeltas(lastSavedState, next, disk);
				const diskHasPending = !!(disk.pendingFrom && disk.pendingReason);
				const nextHasPending = !!(next.pendingFrom && next.pendingReason);
				const canClearDiskPending =
					options.clearPending === "owned-or-legacy"
						? !disk.pendingOwner || disk.pendingOwner === sessionInstanceId
						: options.clearPending === "owned"
							? disk.pendingOwner === sessionInstanceId
							: false;
				const ordinaryWriteMustKeepDiskPending =
					!options.clearPending &&
					diskHasPending &&
					(!nextHasPending ||
						disk.pendingOwner !== sessionInstanceId ||
						next.pendingOwner !== sessionInstanceId);
				if (
					ordinaryWriteMustKeepDiskPending ||
					(!!options.clearPending && diskHasPending && !canClearDiskPending)
				) {
					next = {
						...next,
						pendingFrom: disk.pendingFrom,
						pendingReason: disk.pendingReason,
						pendingSince: disk.pendingSince,
						pendingContinuationPrompt: disk.pendingContinuationPrompt,
						pendingOwner: disk.pendingOwner,
					};
				} else if (
					!options.clearPending &&
					!diskHasPending &&
					nextHasPending &&
					next.pendingOwner !== sessionInstanceId
				) {
					next = {
						...next,
						pendingFrom: undefined,
						pendingReason: undefined,
						pendingSince: undefined,
						pendingContinuationPrompt: undefined,
						pendingOwner: undefined,
					};
				}
				if (!options.writeUserPreferences) {
					next = {
						...next,
						lastUserModel: disk.lastUserModel,
						lastUserThinkingLevel: disk.lastUserThinkingLevel,
						lastModelByFamily: disk.lastModelByFamily,
					};
				}
				return next;
			});
			for (const [map, values] of [
				[exhaustedUntilByProvider, next.exhaustedUntilByProvider],
				[exhaustedUntilByModel, next.exhaustedUntilByModel],
				[invalidatedByProvider, next.invalidatedByProvider],
				[usageUntrustedUntilByProvider, next.usageUntrustedUntilByProvider],
				[usageByProvider, next.usageByProvider],
				[codexModelCatalogByProvider, next.codexModelCatalogByProvider],
				[authTypeByProvider, next.authTypeByProvider],
			] as Array<[Map<string, any>, Record<string, any> | undefined]>) {
				map.clear();
				for (const [key, value] of Object.entries(values ?? {})) map.set(key, value);
			}
			lastSavedState = structuredClone(next);
			usageTelemetryUnsaved = false;
		} catch {
			logEvent("state_write_deferred", { reason: "storage_unavailable_or_busy" });
		}
		persistedState = next;
	}

	function lastProbeMap() {
		return persistedState.lastProbeAtByProvider ?? {};
	}

	function setLastProbe(provider: string) {
		persistedState = {
			...persistedState,
			lastProbeAtByProvider: { ...lastProbeMap(), [provider]: Date.now() },
		};
		persist();
	}


	function clearReauthedInvalidations(auth: Record<string, AuthEntry>) {
		let changed = false;
		for (const [provider, record] of [...invalidatedByProvider.entries()]) {
			const entry = auth[provider];
			const currentHash = entry ? credentialHash(entry) : undefined;
			if (!entry || (currentHash && currentHash !== record.tokenHash)) {
				invalidatedByProvider.delete(provider);
				exhaustedUntilByProvider.delete(provider);
				authFailures.delete(provider);
				changed = true;
			}
		}
		if (changed) persist();
	}

	function markInvalid(provider: string, reason: string) {
		const entry = readAuthFile()[provider];
		const tokenHash = entry ? (credentialHash(entry) ?? "") : "";
		const trimmedReason = reason.slice(0, 500);
		const prev = invalidatedByProvider.get(provider);
		const at = Date.now();
		invalidatedByProvider.set(provider, {
			tokenHash,
			at,
			reason: trimmedReason,
		});
		persist();
		if (!prev || prev.tokenHash !== tokenHash || prev.reason !== trimmedReason) {
			pi.events?.emit?.("pi:auth:invalidated:v1", {
				provider,
				family: classifyProvider(provider, config.qwenProvider),
				reason: trimmedReason,
				at,
			});
		}
	}

	function isInvalidated(provider: string) {
		return invalidatedByProvider.has(provider);
	}

	function isRefreshable(provider: string): boolean {
		const entry = readAuthFile()[provider];
		return (
			!!entry && typeof entry.refresh === "string" && entry.refresh.length > 0
		);
	}

	type ForcedRefreshResult =
		| { status: "refreshed" }
		| { status: "terminal"; error: string }
		| { status: "transient"; error: string }
		| { status: "unsupported" };

	// external: Pi normally refreshes OAuth after the locally recorded expiry.
	const forcedRefreshes = new Map<string, Promise<ForcedRefreshResult>>();
	async function forceRefreshProvider(ctx: any, provider: string): Promise<ForcedRefreshResult> {
		const existing = forcedRefreshes.get(provider);
		if (existing) return existing;
		const pending = performForcedRefresh(ctx, provider);
		forcedRefreshes.set(provider, pending);
		try { return await pending; }
		finally { if (forcedRefreshes.get(provider) === pending) forcedRefreshes.delete(provider); }
	}

	async function performForcedRefresh(
		ctx: any,
		provider: string,
	): Promise<ForcedRefreshResult> {
		const entry = readAuthFile()[provider];
		if (
			!entry ||
			entry.type !== "oauth" ||
			typeof entry.refresh !== "string" ||
			entry.refresh.length === 0
		) {
			return { status: "unsupported" };
		}

		const authStorage = ctx?.modelRegistry?.authStorage;
		if (typeof authStorage?.forceRefreshProvider === "function") {
			return authStorage.forceRefreshProvider(provider);
		}
		// external: Anthropic invalidates the old refresh token as soon as it issues a new one.
		if (!canPersistRefreshedCredentials(authStorage)) {
			return { status: "unsupported" };
		}

		const family = classifyProvider(provider, config.qwenProvider);
		try {
			let refreshed: AuthEntry | undefined;
			let persistedUnderLock = false;
			if (family === "anthropic") {
				const refreshAnthropic = (current: AuthEntry) => refreshAnthropicCredentials(current, undefined, provider);
				if (typeof authStorage?.modify === "function") {
					refreshed = await refreshAndPersistWithStorageLock({
						provider, credentials: entry, authStorage,
						readLatest: () => readAuthFile()[provider],
						refresh: refreshAnthropic,
						isShadowed: stored => isChildFacingPlaceholderForSlot(stored, provider),
						persistShadowed: credential => writeProxyOAuthSidecar({ ...readProxyOAuthSidecar(), [provider]: credential }),
					});
					persistedUnderLock = true;
				} else {
					refreshed = await refreshAnthropic(entry);
				}
			} else if (family === "openai-codex") {
				const refreshCodex = async (current: AuthEntry) => {
					const next = mergeRefreshedCredentials(
						current,
						await requirePiAiOauth().codex.refresh(
							current as any,
							AbortSignal.timeout(30_000),
						),
					) as AuthEntry;
					if (
						current.accountId &&
						next.accountId &&
						current.accountId !== next.accountId
					) {
						throw new Error("OAuth refresh returned credentials for a different account");
					}
					return next;
				};

				if (typeof authStorage?.modify === "function") {
					refreshed = await refreshAndPersistWithStorageLock({
						provider,
						credentials: entry,
						authStorage,
						readLatest: () => readAuthFile()[provider],
						refresh: refreshCodex,
						isShadowed: (stored) =>
							isChildFacingPlaceholderForSlot(stored, provider),
						persistShadowed: (credential) =>
							writeProxyOAuthSidecar({
								...readProxyOAuthSidecar(),
								[provider]: credential,
							}),
					});
					persistedUnderLock = true;
				} else {
					refreshed = await refreshCodex(entry);
				}
			} else if (family === "cursor") {
				refreshed = mergeRefreshedCredentials(
					entry,
					await refreshCursorCredentials(entry.refresh),
				);
			} else if (provider === "xai") {
				const xai = requirePiAiOauth().xai;
				if (!xai) return { status: "unsupported" };
				const signal = AbortSignal.timeout(30_000);
				const refreshedXai = await refreshWithDiskRetry({
					credentials: entry,
					refresh: (credentials) => xai.refresh(credentials, signal),
					storedRefresh: () => storedRefreshToken(provider),
				});
				refreshed = mergeRefreshedCredentials(entry, refreshedXai);
			} else {
				return { status: "unsupported" };
			}

			if (!refreshed?.access) {
				return {
					status: "transient",
					error: "OAuth refresh returned no usable access token",
				};
			}
			if (
				entry.accountId &&
				refreshed.accountId &&
				entry.accountId !== refreshed.accountId
			) {
				return {
					status: "terminal",
					error: "OAuth refresh returned credentials for a different account",
				};
			}

			const persisted =
				persistedUnderLock ||
				(await persistRefreshedCredentials(authStorage, provider, {
					type: "oauth",
					...entry,
					...refreshed,
				}));
			if (!persisted) {
				// external: A successful OAuth refresh may invalidate the old token on the provider server.
				return {
					status: "terminal",
					error:
						"OAuth refresh succeeded but the rotated credential could not be written to auth.json; run /login for this account",
				};
			}
			if (
				ownsSharedChildPublication() &&
				needsAuthShadow(provider) &&
				(isCursorProviderId(provider) || slotProxyPort !== undefined)
			) {
				shadowChildFacingAuth([provider]);
			}
			reloadHostAuth(ctx);
			refreshDiscovery(true, ctx);
			return { status: "refreshed" };
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			return patternMatch(text, TERMINAL_REFRESH_ERROR_PATTERNS)
				? { status: "terminal", error: text }
				: { status: "transient", error: text };
		}
	}

	function registryCodexModels(ctx: any): CodexCatalogModel[] {
		let models: any[] = [];
		try {
			models = ctx?.modelRegistry
				?.getAll?.()
				?.filter((model: any) => model?.provider === CODEX_BASE) ?? [];
		} catch {
			return [];
		}
		return models
			.filter(
				(model) =>
					typeof model?.id === "string" &&
					/gpt|codex|^o\d/i.test(model.id),
			)
			.map((model) => ({
				id: model.id,
				name: typeof model.name === "string" ? model.name : model.id,
				reasoning: model.reasoning !== false,
				...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
				input: Array.isArray(model.input) && model.input.length > 0 ? model.input : ["text"],
				cost:
					model.cost && typeof model.cost === "object"
						? model.cost
						: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow:
					typeof model.contextWindow === "number" ? model.contextWindow : 272_000,
				maxTokens: typeof model.maxTokens === "number" ? model.maxTokens : 128_000,
			})) as CodexCatalogModel[];
	}

	function mergeCodexModels(...groups: CodexCatalogModel[][]): CodexCatalogModel[] {
		const byId = new Map<string, CodexCatalogModel>();
		for (const group of groups) {
			for (const model of group) if (!byId.has(model.id)) byId.set(model.id, model);
		}
		return [...byId.values()].sort(compareCodexModelStrength);
	}



	function anthropicSlotModelIds(): string[] {
		return registryAnthropicModelOrder.length > 0 ? registryAnthropicModelOrder : DEFAULT_ANTHROPIC_MODELS;
	}

	function refreshRegistryAnthropicModels(ctx: any) {
		let hostIds: string[] = [];
		try {
			hostIds =
				ctx?.modelRegistry
					?.getAll?.()
					?.filter((model: any) => model?.provider === ANTHROPIC_BASE)
					?.map((model: any) => model?.id) ?? [];
		} catch {
			hostIds = [];
		}
		const ranked = rankAnthropicModelIds([
			...hostIds,
			...DEFAULT_ANTHROPIC_MODELS,
		]);
		if (ranked.length === 0) return;
		if (ranked.join(",") === registryAnthropicModelOrder.join(",")) return;
		registryAnthropicModelOrder = ranked;
		for (const provider of registeredSlots) {
			if (classifyProvider(provider, config.qwenProvider) !== "anthropic") continue;
			registerAnthropicSlot(
				pi,
				provider,
				ranked,
				numberedAnthropicBaseUrl(provider),
			);
		}
	}

	function refreshRegistryCodexModels(ctx: any) {
		const merged = mergeCodexModels(
			registryCodexModels(ctx),
			DEFAULT_CODEX_MODELS.map((id) => codexModelDef(id) as CodexCatalogModel),
		);
		const ids = merged.map((model) => model.id);
		if (ids.join(",") === registryCodexModelOrder.join(",")) return;
		registryCodexModelOrder = ids;
		for (const provider of registeredSlots) {
			if (classifyProvider(provider, config.qwenProvider) !== "openai-codex") continue;
			if (
				config.autoDiscoverModels &&
				codexModelCatalogByProvider.get(provider)?.models.length
			)
				continue;
			registerCodexCatalog(
				pi,
				provider,
				merged as Array<Record<string, unknown>>,
				numberedCodexBaseUrl(provider),
			);
		}
	}

	async function fetchFreshCodexCatalog(
		ctx: any,
		provider: string,
	): Promise<CodexCatalogModel[]> {
		let entry = readAuthFile()[provider];
		if (!entry) throw new CodexCatalogFetchError(`${provider} has no stored credential`);
		const runFetch = () =>
			fetchCodexModelCatalog(entry, { clientVersion: VERSION });
		try {
			return await runFetch();
		} catch (error) {
			if (
				!(error instanceof CodexCatalogFetchError) ||
				error.status !== 401 ||
				!isRefreshable(provider)
			) {
				throw error;
			}
			const refreshed = await forceRefreshProvider(ctx, provider);
			if (refreshed.status !== "refreshed") throw error;
			entry = readAuthFile()[provider];
			if (!entry) throw error;
			return runFetch();
		}
	}

	// external: OpenAI provides an account-specific model catalog.
	async function syncCodexModelCatalog(ctx: any, force = false) {
		if (!config.autoDiscoverModels) return;
		const auth = readAuthFile();
		const providers = Object.keys(auth).filter(
			(provider) =>
				classifyProvider(provider, config.qwenProvider) === "openai-codex" &&
				isEntryUsable(auth[provider]),
		);
		const registryFallback = mergeCodexModels(
			registryCodexModels(ctx),
			DEFAULT_CODEX_MODELS.map((id) => codexModelDef(id) as CodexCatalogModel),
		);
		let changed = false;
		await Promise.all(
			providers.map(async (provider) => {
				const cached = codexModelCatalogByProvider.get(provider);
				if (
					!force &&
					cached &&
					Date.now() - cached.fetchedAt < CODEX_MODEL_CATALOG_TTL_MS
				) {
					return;
				}
				try {
					const models = await fetchFreshCodexCatalog(ctx, provider);
					codexModelCatalogByProvider.set(provider, {
						fetchedAt: Date.now(),
						models,
					});
					changed = true;
					logEvent("model_catalog_refresh", {
						provider,
						models: models.map((model) => model.id).join(","),
					});
				} catch (error) {
					logEvent("model_catalog_error", {
						provider,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}),
		);

		const allKnown = mergeCodexModels(
			...providers.map(
				(provider) => codexModelCatalogByProvider.get(provider)?.models ?? [],
			),
			registryFallback,
		);
		discoveredCodexModelOrder = allKnown.map((model) => model.id);

		for (const provider of providers) {
			const cached = codexModelCatalogByProvider.get(provider)?.models;
			const models = cached?.length ? cached : registryFallback;
			registerCodexCatalog(
				pi,
				provider,
				models as Array<Record<string, unknown>>,
				provider === CODEX_BASE
					? "https://chatgpt.com/backend-api"
					: numberedCodexBaseUrl(provider),
			);
		}
		for (const provider of registeredSlots) {
			if (classifyProvider(provider, config.qwenProvider) !== "openai-codex") continue;
			if (providers.includes(provider)) continue;
			registerCodexCatalog(
				pi,
				provider,
				allKnown as Array<Record<string, unknown>>,
				numberedCodexBaseUrl(provider),
			);
		}
		if (changed) persist();
		applyOnlyActiveFilter(ctx);
	}

	function ollamaRotationModelIds(): string[] {
		const ids = [...DEFAULT_OLLAMA_MODELS];
		for (const configured of configuredModelIds(OLLAMA_BASE)) {
			if (!ids.includes(configured)) ids.push(configured);
		}
		for (const discovered of discoveredOllamaModelIds) {
			if (!ids.includes(discovered)) ids.push(discovered);
		}
		return ids;
	}

	async function syncOllamaModelCatalog(ctx: any, force = false) {
		if (!config.autoDiscoverModels || !config.includeOllama) return;
		const entry = readAuthFile()[OLLAMA_BASE];
		const key =
			entry && typeof entry.key === "string" && entry.key.length > 0
				? entry.key
				: undefined;
		if (!key) return;
		if (
			!force &&
				ollamaCatalogFetchedAt &&
				Date.now() - ollamaCatalogFetchedAt < OLLAMA_MODEL_CATALOG_TTL_MS
		) {
			return;
		}
		try {
			const ids = await fetchOllamaCloudCatalog(key);
			discoveredOllamaModelIds = ids;
			ollamaCatalogFetchedAt = Date.now();
			logEvent("ollama_catalog_refresh", {
				models: ids.length,
				sample: ids.slice(0, 12).join(","),
			});
		} catch (error) {
			logEvent("ollama_catalog_error", {
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		const models = ollamaRotationModelIds().map((m) => ollamaModelDef(m, OLLAMA_BASE));
		models.push(...configuredOperationModels(OLLAMA_BASE));
		pi.registerProvider(OLLAMA_BASE, {
			name: "Ollama",
			baseUrl: OLLAMA_CLOUD_BASE_URL,
			api: "openai-completions" as any,
			apiKey: key,
			models: models as any,
		} as any);
		for (const provider of registeredSlots) {
			if (classifyProvider(provider, config.qwenProvider) !== "ollama") continue;
			const slotEntry = readAuthFile()[provider];
			const slotKey =
				slotEntry && typeof slotEntry.key === "string" && slotEntry.key.length > 0
					? slotEntry.key
					: undefined;
			if (!slotKey) continue;
			pi.registerProvider(provider, {
				name: `Ollama (${provider})`,
				baseUrl: OLLAMA_CLOUD_BASE_URL,
				api: "openai-completions" as any,
				apiKey: slotKey,
				models: ollamaRotationModelIds().map((m) => ollamaModelDef(m, provider)) as any,
			} as any);
		}
		applyOnlyActiveFilter(ctx);
	}

	function cachedUsage(provider: string, auth?: Record<string, AuthEntry>): UsageSnapshot | undefined {
		const snapshot = usageByProvider.get(provider);
		if (!snapshot) return undefined;
		const entry = (auth ?? readAuthFile())[provider];
		const currentHash = entry ? credentialHash(entry) : undefined;
		if (snapshot.credentialHash && snapshot.credentialHash !== currentHash)
			return undefined;
		return snapshot;
	}

	function usageCacheTtl(provider: string): number {
		const family = usageFamily(provider);
		if (family === "anthropic") {
			return Math.max(config.usageRefreshMs, MIN_ANTHROPIC_USAGE_REFRESH_MS);
		}
		if (family === "ollama" || family === "cursor") {
			return Math.max(config.usageRefreshMs, 5 * 60_000);
		}
		return config.usageRefreshMs;
	}

	// external: Qwen does not expose a live quota endpoint.
	function qwenLiveStatus(provider: string): string {
		if (isInvalidated(provider))
			return "needs re-login (/login → subscription → alibaba)";
		const now = Date.now();
		const until = providerRecoveryAt(provider, now);
		if (until > now) return `rate-limited · retry in ${formatDelay(until - now)}`;
		return "available · Alibaba exposes no quota API";
	}

	function displayUsageSnapshot(snapshot: UsageSnapshot): UsageSnapshot {
		return snapshot.family === "qwen"
			? { ...snapshot, plan: qwenLiveStatus(snapshot.provider) }
			: snapshot;
	}

	function readyElsewhereCount(
		ctx: any,
		current: string | undefined,
		auth: Record<string, AuthEntry> = readAuthFile(),
	): number {
		const now = Date.now();
		return rotation.filter(
			(provider) =>
				provider !== current &&
				!isInvalidated(provider) &&
				providerHasUsableAuth(ctx, provider, auth) &&
				providerRecoveryAt(provider, now) <= now,
		).length;
	}

	function publishUsageSnapshot(snapshot: UsageSnapshot | undefined) {
		if (!snapshot) return;
		pi.events.emit("pi:usage:snapshot:v1", {
			provider: snapshot.provider,
			family: snapshot.family,
			fetchedAt: snapshot.fetchedAt,
			...(snapshot.primary ? { primary: { usedPercent: snapshot.primary.usedPercent, resetAt: snapshot.primary.resetAt } } : {}),
			...(snapshot.secondary ? { secondary: { usedPercent: snapshot.secondary.usedPercent, resetAt: snapshot.secondary.resetAt } } : {}),
		});
	}

	function renderUsageStatus(
		ctx: any,
		provider: string,
		snapshot: UsageSnapshot,
		auth?: Record<string, AuthEntry>,
	) {
		const display = displayUsageSnapshot(snapshot);
		const spare = readyElsewhereCount(ctx, provider, auth);
		const text = `${formatUsageCompact(display, Date.now(), { windows: config.showUsageWindows })} | ${
			spare > 0 ? `+${spare} ready` : "no spare"
		}`;
		const color =
			snapshot.family === "qwen"
				? isInvalidated(provider)
					? "error"
					: providerRecoveryAt(provider) > Date.now()
						? "warning"
						: "success"
				: usageColor(display);
		let rendered: string = text;
		try {
			if (ctx.ui.theme?.fg) rendered = ctx.ui.theme.fg(color, text);
		} catch {
			rendered = text;
		}
		ctx.ui.setStatus("multi-account-quota", rendered);
	}

	function updateUsageStatus(
		ctx: any,
		provider = ctx?.model?.provider,
		auth?: Record<string, AuthEntry>,
	) {
		if (typeof ctx?.ui?.setStatus !== "function") return;
		try {
			if (!provider || !usageFamily(provider)) {
				ctx.ui.setStatus("multi-account-quota", undefined);
				return;
			}
			const snapshot: UsageSnapshot | undefined =
				cachedUsage(provider, auth) ??
				usageByProvider.get(provider) ??
				(usageFamily(provider) === "qwen"
					? {
							provider,
							family: "qwen" as const,
							fetchedAt: Date.now(),
							plan: "",
						}
					: undefined);
			publishUsageSnapshot(snapshot);
			if (!config.showUsage || !snapshot) {
				ctx.ui.setStatus("multi-account-quota", undefined);
				return;
			}
			renderUsageStatus(ctx, provider, snapshot, auth);
		} catch {
		}
	}

	pi.events.on("pi:usage:request:v1", (request: any) => {
		if (request?.provider === completionRouterContext?.model?.provider) {
			updateUsageStatus(completionRouterContext);
		}
	});

	pi.events.on("pi:auth:updated:v1", (event: any) => {
		const provider = typeof event?.provider === "string" ? event.provider : undefined;
		if (!provider) return;
		if (
			ownsSharedChildPublication() &&
			needsAuthShadow(provider) &&
			(isCursorProviderId(provider) || slotProxyPort !== undefined)
		) {
			shadowChildFacingAuth([provider]);
		}
		const auth = readAuthFile();
		clearReauthedInvalidations(auth);
		noteAuthSuccess(provider);
		const ctx = completionRouterContext ?? slotProxyContext;
		if (ctx) reloadHostAuth(ctx);
		refreshDiscovery(true, ctx);
		if (event?.skipPendingResume) {
			if (hasPendingResume()) clearPendingContinuation();
		} else if (ctx && hasPendingResume()) {
			void attemptPendingResume(ctx);
		}
	});

	function usageSnapshotIsCurrent(
		snapshot: UsageSnapshot,
		auth: Record<string, AuthEntry> = readAuthFile(),
	): boolean {
		if (sessionClosed) return false;
		const entry = auth[snapshot.provider];
		return !!entry && (!snapshot.credentialHash || snapshot.credentialHash === credentialHash(entry));
	}

	function flushUsageTelemetry() {
		if (usageTelemetryUnsaved) persist();
	}

	function storeUsage(
		ctx: any,
		snapshot: UsageSnapshot,
		options: { fromResponseHeaders?: boolean; auth?: Record<string, AuthEntry> } = {},
	): boolean {
		if (!usageSnapshotIsCurrent(snapshot, options.auth)) return false;
		const previous = usageByProvider.get(snapshot.provider);
		snapshot = mergeUsageSnapshot(previous, snapshot);
		usageByProvider.set(snapshot.provider, snapshot);
		usageTelemetryUnsaved = true;
		usageErrors.delete(snapshot.provider);
		const blockMs = cooldownMsFromUsage(snapshot);
		if (blockMs !== undefined && blockMs > 0) {
			markExhausted(snapshot.provider, blockMs);
		} else if (blockMs === 0) {
			applyUsageToCooldown(snapshot.provider, snapshot, Date.now());
		}
		if (options.fromResponseHeaders && blockMs === 0 && sameUsageReading(previous, snapshot)) {
			updateUsageStatus(ctx, undefined, options.auth);
			return true;
		}
		logEvent("usage_refresh", {
			provider: snapshot.provider,
			family: snapshot.family,
			plan: snapshot.plan ?? "unknown",
			primaryUsedPercent: snapshot.primary?.usedPercent ?? "unknown",
			blocked: blockMs !== undefined && blockMs > 0,
		});
		persist();
		updateUsageStatus(ctx, undefined, options.auth);
		return true;
	}

	async function fetchFreshUsage(
		ctx: any,
		provider: string,
	): Promise<UsageSnapshot> {
		let entry = readAuthFile()[provider];
		if (!entry)
			throw new UsageFetchError(`${provider} has no stored credential`);
		const runFetch = () =>
			fetchUsageSnapshot(provider, entry, {
				credentialHash: credentialHash(entry),
			});
		try {
			return await runFetch();
		} catch (error) {
			if (
				!(error instanceof UsageFetchError) ||
				error.status !== 401 ||
				!isRefreshable(provider)
			)
				throw error;
			const refreshed = await forceRefreshProvider(ctx, provider);
			if (refreshed.status !== "refreshed") throw error;
			entry = readAuthFile()[provider];
			if (!entry) throw error;
			return runFetch();
		}
	}

	async function refreshUsage(
		ctx: any,
		provider = ctx?.model?.provider,
		force = false,
		allowWhenHidden = false,
	): Promise<UsageSnapshot | undefined> {
		if ((!config.showUsage && !allowWhenHidden) || !provider || !usageFamily(provider)) {
			updateUsageStatus(ctx, provider);
			return undefined;
		}
		const cached = cachedUsage(provider);
		if (
			!force &&
			cached &&
			Date.now() - cached.fetchedAt < usageCacheTtl(provider)
		) {
			updateUsageStatus(ctx, provider);
			return cached;
		}
		const existing = usageFetches.get(provider);
		if (existing) {
			try {
				const snapshot = await existing;
				return usageSnapshotIsCurrent(snapshot) ? snapshot : undefined;
			} catch {
				updateUsageStatus(ctx, provider);
				return cached;
			}
		}
		const fetchPromise = fetchFreshUsage(ctx, provider);
		usageFetches.set(provider, fetchPromise);
		try {
			const snapshot = await fetchPromise;
			return storeUsage(ctx, snapshot) ? snapshot : undefined;
		} catch (error) {
			usageErrors.set(
				provider,
				error instanceof Error ? error.message : String(error),
			);
			updateUsageStatus(ctx, provider);
			return cached;
		} finally {
			usageFetches.delete(provider);
		}
	}

	const AGY_QUOTA_REFRESH_MS = 15 * 60_000;
	const AGY_QUOTA_HOME = join(tmpdir(), "agy-quota-home");
	let agyQuotaFetch: Promise<UsageSnapshot | undefined> | undefined;
	let lastAgyQuotaAttemptAt = 0;

	function runAgyQuotaCommand(agyBin: string): Promise<string> {
		return new Promise((resolve, reject) => {
			const isWinCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(agyBin);
			const file = isWinCmd ? process.env.ComSpec || "cmd.exe" : agyBin;
			const args = isWinCmd ? ["/d", "/s", "/c", agyBin, "-p=/quota"] : ["-p=/quota"];
			execFile(
				file,
				args,
				{
					encoding: "utf8",
					windowsHide: true,
					timeout: 30_000,
					// external: Antigravity login uses the OS credential store.
					env: { ...process.env, MSYS_NO_PATHCONV: "1", USERPROFILE: AGY_QUOTA_HOME, HOME: AGY_QUOTA_HOME, AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
				},
				(error, stdout) => {
					if (error) reject(error);
					else resolve(stdout ?? "");
				},
			);
		});
	}

	async function refreshAgyQuota(force = false): Promise<UsageSnapshot | undefined> {
		const previous = usageByProvider.get("agy");
		const configuredBin = process.env.AGY_BIN?.trim();
		if (process.env.PI_OFFLINE === "1" && !configuredBin) return previous;
		const now = Date.now();
		if (
			!force &&
			((previous && now - previous.fetchedAt < AGY_QUOTA_REFRESH_MS) ||
				(lastAgyQuotaAttemptAt > 0 && now - lastAgyQuotaAttemptAt < AGY_QUOTA_REFRESH_MS))
		) {
			return previous;
		}
		if (agyQuotaFetch) return agyQuotaFetch;
		lastAgyQuotaAttemptAt = now;
		const agyBin = configuredBin || "agy";
		agyQuotaFetch = (async () => {
			try {
				const stdout = await runAgyQuotaCommand(agyBin);
				const snapshot = parseAgyQuota(stdout, Date.now());
				if (!snapshot) {
					logEvent("agy_quota_failed", { reason: "empty_or_malformed" });
					return previous;
				}
				if (sessionClosed) return previous;
				usageByProvider.set("agy", snapshot);
				usageTelemetryUnsaved = true;
				logEvent("usage_refresh", {
					provider: "agy",
					family: "agy",
					primaryUsedPercent: snapshot.primary?.usedPercent ?? "unknown",
					secondaryUsedPercent: snapshot.secondary?.usedPercent ?? "unknown",
				});
				persist();
				return snapshot;
			} catch (error) {
				logEvent("agy_quota_failed", {
					reason: agyFailureReason(error, configuredBin),
				});
				return previous;
			} finally {
				agyQuotaFetch = undefined;
			}
		})();
		return agyQuotaFetch;
	}

	async function refreshRotationUsage(ctx: any, force = false) {
		if (!config.showUsage) {
			updateUsageStatus(ctx);
			return;
		}
		const providers = [
			...new Set(
				[...rotation, ctx?.model?.provider].filter(
					(provider): provider is string =>
						typeof provider === "string" &&
						!!usageFamily(provider) &&
						providerHasUsableAuth(ctx, provider),
				),
			),
		];
		await Promise.all([
			...providers.map((provider) => refreshUsage(ctx, provider, force)),
			refreshAgyQuota(force),
		]);
		updateUsageStatus(ctx);
	}

	async function refreshAccountMetadata(ctx: any, options: { usage: boolean; force: boolean }): Promise<void> {
		const outcomes = await Promise.allSettled([
			options.usage ? refreshRotationUsage(ctx) : undefined,
			syncCodexModelCatalog(ctx, options.force),
			syncOllamaModelCatalog(ctx, options.force),
		]);
		const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
		if (failed) throw failed.reason;
	}

	function accountUsageCell(
		snapshot: UsageSnapshot | undefined,
		position: UsageWindowPosition,
		now: number,
	): string {
		const window = snapshot?.[position];
		if (!snapshot || !window) return "—";
		return `${windowLabel(window, snapshot.family, position)} ${remainingPercent(window)}%/${formatResetDuration(window.resetAt, now)}`;
	}

	function cooldownStatus(snapshot: UsageSnapshot | undefined, recoveryAt: number, now: number) {
		const recheck = formatResetDuration(recoveryAt, now);
		const resetMs = snapshot && snapshot.serviceable !== true ? cooldownMsFromUsage(snapshot, now) : undefined;
		if (!resetMs || now + resetMs <= recoveryAt) return `cooldown ${recheck}`;
		return `spent · resets ${formatResetDuration(now + resetMs, now)} · recheck ${recheck}`;
	}

	function accountRows(ctx: any, now: number) {
		const auth = readAuthFile();
		const ordered = [
			...rotation,
			...Object.keys(auth)
				.filter((provider) => !rotation.includes(provider))
				.sort((a, b) => a.localeCompare(b)),
		];
		const duplicateOf = new Map(
			duplicateSlots.map(({ duplicate, primary }) => [duplicate, primary]),
		);
		const unconfigured = new Set(unconfiguredRotationMembers(ctx));
		return ordered.map((provider) => {
			const entry = auth[provider];
			const authType = authTypeOfEntry(entry);
			const snapshot = cachedUsage(provider, auth);
			const duplicate = duplicateOf.get(provider);
			const recoveryAt = providerRecoveryAt(provider, now);
			let status: string;
			if (!entry || !isEntryUsable(entry)) status = "unavailable · no credential";
			else if (isInvalidated(provider)) status = "unavailable · re-login";
			else if (duplicate) status = `duplicate → ${duplicate}`;
			else if (unconfigured.has(provider)) status = "unavailable · no models";
			else if (recoveryAt > now) status = cooldownStatus(snapshot, recoveryAt, now);
			else if (usageErrors.has(provider)) status = "ready · usage unavailable";
			else status = "ready";
			return { provider, authType, snapshot, status, ready: status.startsWith("ready") };
		});
	}

	function accountChoices(): AccountChoice[] {
		let ctx = completionRouterContext;
		let current: string | undefined;
		try {
			current = ctx?.model?.provider;
		} catch {
			// external: A context from a replaced Pi session may throw on access.
			ctx = undefined;
		}
		refreshDiscovery(false);
		const now = Date.now();
		return accountRows(ctx, now).map(({ provider, authType, snapshot, status, ready }) => ({
			provider,
			authType,
			status,
			ready,
			current: provider === current,
			account: snapshot?.account,
			usage: snapshot?.primary ? accountUsageCell(snapshot, "primary", now) : undefined,
		}));
	}

	function renderAccountTable(ctx: any): string {
		refreshDiscovery(false, ctx);
		const now = Date.now();
		const accounts = accountRows(ctx, now);
		const rows = accounts.map(({ provider, authType, snapshot, status }) => {
			const account = snapshot?.account ?? "—";
			const alias =
				snapshot?.account && snapshot.account.includes("@")
					? snapshot.account.slice(0, snapshot.account.indexOf("@"))
					: snapshot?.account ?? "—";
			return [
				provider,
				authType ?? "—",
				alias,
				account,
				snapshot?.plan ?? "—",
				accountUsageCell(snapshot, "primary", now),
				accountUsageCell(snapshot, "secondary", now),
				accountUsageCell(snapshot, "tertiary", now),
				status,
			];
		});
		const agySnapshot = usageByProvider.get("agy");
		const agyLines = agySnapshot ? [formatAgyQuotaLine(agySnapshot, now)] : [];
		if (rows.length === 0) {
			return [
				"pi-multi-account accounts: no configured accounts in auth.json",
				...agyLines,
			].join("\n");
		}
		const header = ["Slot", "Auth", "Alias", "Account", "Plan", "Primary", "Secondary", "Tertiary", "Status"];
		const widths = header.map((title, column) =>
			Math.max(title.length, ...rows.map((row) => row[column].length)),
		);
		const line = (row: string[]) =>
			row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd();
		return [
			"pi-multi-account accounts — provider metadata only; — = not reported",
			line(header),
			line(widths.map((width) => "-".repeat(width))),
			...rows.map(line),
			...agyLines,
			...(accounts.some(({ snapshot }) => snapshot?.family === "anthropic" && snapshot.plan === "api-key")
				? [ANTHROPIC_API_KEY_BILLING_NOTE] : []),
			"Use /multi-account accounts refresh to refresh every supported account explicitly.",
		].join("\n");
	}

	function clearUsageStatusTimer() {
		if (!usageStatusTimer) return;
		clearInterval(usageStatusTimer);
		usageStatusTimer = undefined;
	}

	function startUsageStatusTimer(ctx: any) {
		clearUsageStatusTimer();
		if (subagentChild) return;
		if (!config.showUsage && !config.autoDiscoverModels) {
			updateUsageStatus(ctx);
			return;
		}
		usageStatusTimer = setInterval(() => {
			runBackground("rotation metadata refresh", ctx, async () => {
				flushUsageTelemetry();
				await refreshRotationUsage(ctx);
				if (ctx?.isIdle?.() !== false) await syncCodexModelCatalog(ctx);
				if (ctx?.isIdle?.() !== false) await syncOllamaModelCatalog(ctx);
			});
		}, config.usageStatusRefreshMs);
		(usageStatusTimer as any).unref?.();
	}

	function noteAuthSuccess(provider: string, modelId?: string) {
		limitStreakByProvider.delete(provider);
		let changed = usageUntrustedUntilByProvider.delete(provider);
		changed = authFailures.delete(provider) || changed;
		changed = exhaustedUntilByProvider.delete(provider) || changed;
		changed = invalidatedByProvider.delete(provider) || changed;
		if (modelId)
			changed = exhaustedUntilByModel.delete(ref(provider, modelId)) || changed;
		if (changed) persist();
	}

	function markAuthFailure(provider: string, reason: string): boolean {
		if (patternMatch(reason, TERMINAL_AUTH_ERROR_PATTERNS)) {
			authFailures.delete(provider);
			markInvalid(provider, reason);
			return true;
		}
		const entry = readAuthFile()[provider];
		const hash = (entry ? credentialHash(entry) : undefined) ?? "";
		const prev = authFailures.get(provider);
		if (prev && prev.hash === hash) {
			if (!isRefreshable(provider)) {
				const distinct = (prev.distinct ?? 0) + 1;
				if (distinct >= MAX_SAME_KEY_AUTH_FAILURES) {
					authFailures.delete(provider);
					markInvalid(provider, `${reason} (after ${distinct} same-key 401s)`);
					return true;
				}
				authFailures.set(provider, { hash, distinct });
			}
			markExhausted(provider, TRANSIENT_AUTH_COOLDOWN_MS);
			return false;
		}
		const distinct = (prev?.distinct ?? 0) + 1;
		if (distinct >= MAX_CONSECUTIVE_AUTH_FAILURES) {
			authFailures.delete(provider);
			markInvalid(
				provider,
				`${reason} (after ${distinct} refreshed-token 401s)`,
			);
			return true;
		}
		authFailures.set(provider, { hash, distinct });
		markExhausted(provider, TRANSIENT_AUTH_COOLDOWN_MS);
		return false;
	}


	function pruneCooldowns() {
		const now = Date.now();
		let changed = false;
		const ceiling = now + MAX_LIVE_COOLDOWN_MS;
		for (const [provider, until] of exhaustedUntilByProvider) {
			if (until <= now && !isInvalidated(provider)) {
				exhaustedUntilByProvider.delete(provider);
				changed = true;
			} else if (until > ceiling) {
				exhaustedUntilByProvider.set(provider, ceiling);
				changed = true;
			}
		}
		for (const [model, until] of exhaustedUntilByModel) {
			if (until <= now) {
				exhaustedUntilByModel.delete(model);
				changed = true;
			}
		}
		if (changed) persist();
	}

	function isTransientPendingReason(reason: string) {
		return reason.startsWith(TRANSIENT_PENDING_PREFIX);
	}

	function isBusyRetryPendingReason(reason: string) {
		return reason === BUSY_RETRY_REASON;
	}

	function isSelectedFallbackPendingReason(reason: string) {
		return reason.startsWith(SELECTED_FALLBACK_PENDING_PREFIX);
	}

	function isSameModelResumeReason(reason: string) {
		return (
			isTransientPendingReason(reason) ||
			isBusyRetryPendingReason(reason) ||
			isSelectedFallbackPendingReason(reason)
		);
	}

	function isAuthPendingReason(reason: string) {
		const lower = reason.toLowerCase();
		return (
			lower.includes("auth invalid") ||
			lower.includes("auth failure") ||
			lower.includes("invalid api-key") ||
			lower.includes("invalid api key")
		);
	}

	function usageUntrusted(provider: string, now = Date.now()): boolean {
		return (usageUntrustedUntilByProvider.get(provider) ?? 0) > now;
	}

	function noteLimitError(provider: string, now = Date.now()): number {
		const prev = limitStreakByProvider.get(provider);
		const count =
			prev && now - prev.lastAt < LIMIT_STREAK_WINDOW_MS ? prev.count + 1 : 1;
		limitStreakByProvider.set(provider, { count, lastAt: now });
		if (count >= 2) markUsageUntrusted(provider, now);
		return count;
	}

	function markUsageUntrusted(provider: string, now = Date.now()) {
		const until = now + USAGE_UNTRUSTED_MS;
		if ((usageUntrustedUntilByProvider.get(provider) ?? 0) >= until) return;
		usageUntrustedUntilByProvider.set(provider, until);
		persist();
	}

	function isConfirmedAvailable(provider: string, now = Date.now()): boolean {
		const cached = usageByProvider.get(provider);
		return (
			!!cached &&
			cached.serviceable === true &&
			now - cached.fetchedAt < usageCacheTtl(provider)
		);
	}

	function providerRecoveryAt(
		provider: string,
		now = Date.now(),
		options: { ignoreCeiling?: boolean } = {},
	): number {
		const capped = (at: number, takenAt: number) =>
			options.ignoreCeiling
				? at
				: Math.max(now, Math.min(at, takenAt + config.maxRecheckIntervalMs));
		let at = Math.max(now, exhaustedUntilByProvider.get(provider) ?? now);
		const cached = usageByProvider.get(provider);
		if (cached) {
			const fresh = now - cached.fetchedAt < usageCacheTtl(provider);
			if (fresh && cached.serviceable === true) return now;
			if (fresh && cached.serviceable === false)
				return capped(
					Math.max(at, now + config.maxRecheckIntervalMs),
					cached.fetchedAt,
				);
			const usageMs = cooldownMsFromUsage(cached, now);
			if (usageMs !== undefined && usageMs > 0)
				return capped(now + usageMs, cached.fetchedAt);
			if (fresh && usageMs === 0)
				return usageUntrusted(provider, now) ? at : now;
		}
		return at;
	}

	function nextRecoveryStatus(ctx: any): string {
		const now = Date.now();
		reconcileCooldownsFromUsage(ctx);
		const providers = rotation.filter((p) => !isInvalidated(p));
		if (providers.length === 0)
			return "none — no authenticated accounts in rotation";

		const cooling = providers
			.map((provider) => ({ provider, at: providerRecoveryAt(provider, now) }))
			.filter(({ at }) => at > now + 500)
			.sort((a, b) => a.at - b.at);

		if (cooling.length === 0) return "all rotation accounts available now";

		const parts: string[] = [];
		const first = cooling[0];
		parts.push(
			`first: ${first.provider} in ~${formatDelay(first.at - now)} (${formatUntil(first.at)})`,
		);
		if (cooling.length > 1) {
			const also = cooling
				.slice(1, 4)
				.map((r) => `${r.provider} ~${formatDelay(r.at - now)}`)
				.join(", ");
			parts.push(`then: ${also}${cooling.length > 4 ? ", …" : ""}`);
		}
		if (hasPendingResume()) {
			const wake = nextPendingWakeDelayMs();
			if (wake !== undefined)
				parts.push(`auto-resume check in ~${formatDelay(wake)}`);
		} else if (queuedUserInputs.length > 0) {
			const wake = nextModelAvailabilityDelayMs(ctx);
			if (wake !== undefined)
				parts.push(`queued input send in ~${formatDelay(wake)}`);
		}
		return parts.join(" · ");
	}

	async function resolveLimitCooldownMs(
		ctx: any,
		provider: string,
		errorText: string,
	): Promise<number> {
		const now = Date.now();
		noteLimitError(provider, now);
		const statedMs = cooldownFromErrorText(errorText);
		const knownUsage = usageByProvider.get(provider);
		if (
			typeof statedMs === "number" &&
			statedMs > SESSION_LIMIT_FLOOR_MS &&
			knownUsage &&
			cooldownMsFromUsage(knownUsage, now) === 0
		) {
			markUsageUntrusted(provider, now);
		}
		const hintedCooldowns = [
			responseCooldownHints.get(provider),
			statedMs,
		].filter(
			(value): value is number => typeof value === "number" && value > 0,
		);
		const snapshot = await refreshUsage(ctx, provider, true);
		if (snapshot) {
			applyUsageToCooldown(provider, snapshot, now);
			const usageMs = cooldownMsFromUsage(snapshot);
			if (usageMs === 0) {
				markUsageUntrusted(provider, now);
				hintedCooldowns.push(SESSION_LIMIT_FLOOR_MS);
			} else if (usageMs !== undefined && usageMs > 0) {
				hintedCooldowns.push(usageMs);
			}
		}
		if (hintedCooldowns.length === 0) return config.cooldownMs;
		return Math.min(Math.max(...hintedCooldowns), MAX_LIVE_COOLDOWN_MS);
	}

	function providersSharingAccount(provider: string): string[] {
		const auth = readAuthFile();
		const identity = auth[provider]
			? accountIdentity(auth[provider])
			: undefined;
		if (!identity) return [provider];
		const shared = Object.keys(auth).filter((p) => {
			const e = auth[p];
			return e && accountIdentity(e) === identity;
		});
		return shared.length > 0 ? shared : [provider];
	}

	function hasCheapAvailabilityProbe(provider: string): boolean {
		const family = usageFamily(provider);
		if (family === "xai" || family === "anthropic")
			return readAuthFile()[provider]?.type === "oauth";
		if (family === "zai-coding-cn") return readAuthFile()[provider]?.type === "api_key";
		return (
			family === "codex" ||
			family === "ollama" ||
			family === "cursor"
		);
	}

	function markExhausted(provider: string, cooldownMs: number) {
		if (cooldownMs <= 0) return;
		setLastProbe(provider);
		const until =
			Date.now() +
			Math.min(
				Math.max(cooldownMs, 1000),
				hasCheapAvailabilityProbe(provider)
					? config.maxRecheckIntervalMs
					: Number.POSITIVE_INFINITY,
				MAX_LIVE_COOLDOWN_MS,
			);
		for (const candidate of providersSharingAccount(provider)) {
			exhaustedUntilByProvider.set(
				candidate,
				Math.max(exhaustedUntilByProvider.get(candidate) ?? 0, until),
			);
		}
		persist();
	}

	function markModelExhausted(model: any, cooldownMs: number) {
		if (!model?.provider || !model?.id) return;
		const key = ref(model.provider, model.id);
		const until = Date.now() + Math.max(cooldownMs, 1000);
		exhaustedUntilByModel.set(
			key,
			Math.max(exhaustedUntilByModel.get(key) ?? 0, until),
		);
		persist();
	}

	function applyUsageToCooldown(
		provider: string,
		snapshot: UsageSnapshot,
		now: number,
	) {
		if (snapshot.serviceable === true) {
			const refusedAt = limitStreakByProvider.get(provider)?.lastAt;
			if (typeof refusedAt === "number" && snapshot.fetchedAt < refusedAt) return;
			let changed = exhaustedUntilByProvider.delete(provider);
			changed = usageUntrustedUntilByProvider.delete(provider) || changed;
			if (changed) persist();
			return;
		}
		if (snapshot.serviceable === false) return;
		const realMs = cooldownMsFromUsage(snapshot, now);
		if (realMs === undefined) return;
		const recorded = exhaustedUntilByProvider.get(provider) ?? 0;
		if (realMs <= 0) {
			if (usageUntrusted(provider, now)) return;
			if (exhaustedUntilByProvider.delete(provider)) persist();
			return;
		}
		const realUntil = now + realMs;
		if (recorded > now && realUntil < recorded) {
			exhaustedUntilByProvider.set(provider, realUntil);
			persist();
		}
	}

	function reconcileCooldownsFromUsage(
		ctx: any,
		options: { allowWhenHidden?: boolean } = {},
	) {
		const now = Date.now();
		for (const [provider, until] of [...exhaustedUntilByProvider.entries()]) {
			if (until <= now || isInvalidated(provider) || !usageFamily(provider))
				continue;
			runBackground("cooldown reconcile usage", ctx, async () => {
				const snapshot = await refreshUsage(
					ctx,
					provider,
					true,
					options.allowWhenHidden ?? false,
				);
				if (
					snapshot &&
					pendingResume?.mode === "quota-recovery" &&
					providerRecoveryAt(provider) <= Date.now()
				) {
					schedulePendingWake(ctx);
				}
			});
			const cached = usageByProvider.get(provider);
			if (cached && now - cached.fetchedAt < usageCacheTtl(provider))
				applyUsageToCooldown(provider, cached, now);
		}
	}


	function discoverRotation(auth: Record<string, AuthEntry>): string[] {
		const byFamily: Record<ProviderFamily, string[]> = {
			anthropic: [],
			"openai-codex": [],
			"kimi-coding": [],
			cursor: [],
			qwen: [],
			ollama: [],
		};
		for (const [id, entry] of Object.entries(auth)) {
			const family = classifyProvider(id, config.qwenProvider);
			if (!family) continue;
			if (family === "qwen" && !config.includeQwen) continue;
			if (family === "ollama" && !config.includeOllama) continue;
			if (family === "cursor" && !config.includeCursor) continue;
			if (!isEntryUsable(entry)) continue;
			if (isInvalidated(id)) continue;
			byFamily[family].push(id);
		}
		const order = config.providerOrder.length
			? config.providerOrder
			: DEFAULT_PROVIDER_ORDER;
		const seenIdentity = new Set<string>();
		const result: string[] = [];
		for (const family of order) {
			const ids = byFamily[family].sort((a, b) => slotIndex(a) - slotIndex(b));
			for (const id of ids) {
				const identity = accountIdentity(auth[id]);
				if (identity && seenIdentity.has(identity)) continue;
				if (identity) seenIdentity.add(identity);
				result.push(id);
			}
		}
		if (config.includeOtherProviders) {
			for (const [id, entry] of Object.entries(auth)) {
				if (classifyProvider(id, config.qwenProvider)) continue;
				if (!isEntryUsable(entry) || isInvalidated(id)) continue;
				const identity = accountIdentity(entry);
				if (identity && seenIdentity.has(identity)) continue;
				if (identity) seenIdentity.add(identity);
				result.push(id);
			}
		}
		return result;
	}

	function unmanagedRotationMembers(): string[] {
		return rotation.filter(
			(id) => !classifyProvider(id, config.qwenProvider),
		);
	}

	function meteredNativeMembers(): string[] {
		return unmanagedRotationMembers().filter((id) =>
			METERED_NATIVE_PROVIDERS.has(id.replace(/-account-\d+$/, "")),
		);
	}

	function resellerRotationMembers(): string[] {
		const metered = new Set(meteredNativeMembers());
		return unmanagedRotationMembers().filter((id) => !metered.has(id));
	}

	function unconfiguredRotationMembers(ctx: any): string[] {
		if (!ctx?.modelRegistry?.getAll) return [];
		return rotation.filter((id) => {
			if (classifyProvider(id, config.qwenProvider)) return false;
			return hostModelIdsFor(ctx, id).length === 0;
		});
	}

	function discoverDuplicateSlots(auth: Record<string, AuthEntry>) {
		const primaryByIdentity = new Map<string, string>();
		const duplicates: Array<{ duplicate: string; primary: string }> = [];
		for (const id of Object.keys(auth).sort(
			(a, b) => slotIndex(a) - slotIndex(b),
		)) {
			const family = classifyProvider(id, config.qwenProvider);
			if (!family || !isEntryUsable(auth[id])) continue;
			const identity = accountIdentity(auth[id]);
			if (!identity) continue;
			const primary = primaryByIdentity.get(identity);
			if (primary) duplicates.push({ duplicate: id, primary });
			else primaryByIdentity.set(identity, id);
		}
		return duplicates;
	}

	async function refreshCursorSlots(
		auth: Record<string, AuthEntry>,
		ctx?: any,
		explicit = false,
	) {
		if (!config.includeCursor) return;
		if (!explicit && !isCursorProviderInstalled()) return;
		const slotIds = [
			...new Set([
				...Object.keys(auth).filter(
					(id) =>
						isCursorProviderId(id) &&
						id !== CURSOR_BASE &&
						isEntryUsable(auth[id]),
				),
				...[...registeredSlots].filter(
					(id) => isCursorProviderId(id) && id !== CURSOR_BASE,
				),
			]),
		].sort((a, b) => slotIndex(a) - slotIndex(b));
		try {
			await setupCursorSubscription(pi, {
				readAuth: readAuthFile,
				rejectDuplicateLogin: (slot, creds) => rejectDuplicateLogin(slot, creds),
				slotIds,
				notify: (message, level) => ctx?.ui?.notify?.(message, level),
				log: (kind, data) => logEvent(kind, data),
				onProvision: async (slots, port, models) => {
					if (!ownsSharedChildPublication()) return;
					for (const slot of slots) {
						await publishNativeSlot(slot, {
							api: "openai-completions",
							baseUrl: `http://127.0.0.1:${port}/v1`,
							apiKey: CURSOR_PROXY_PLACEHOLDER_KEY,
							models,
						});
					}
					// external: Pi may ignore a models.json placeholder when a stored OAuth credential takes precedence.
					if (!sessionClosed && ownsSharedChildPublication()) shadowChildFacingAuth(slots);
				},
			});
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			logEvent("cursor_setup_failed", { reason });
			if (!cursorSetupFailureNotified && typeof ctx?.ui?.notify === "function") {
				cursorSetupFailureNotified = true;
				ctx.ui.notify(
					`pi-multi-account: built-in Cursor support failed to load, so Cursor accounts are unavailable this session (${reason.slice(0, 160)}). Everything else keeps working; set "includeCursor": false in ${CONFIG_PATH} to silence this.`,
					"warning",
				);
			}
		}
	}

	function syncRegisteredSlots(auth: Record<string, AuthEntry>, ctx?: any) {
		const cursorAvailable = config.includeCursor && isCursorProviderInstalled();
		const families: ProviderFamily[] = [
			"anthropic",
			"openai-codex",
			"kimi-coding",
			...(cursorAvailable ? (["cursor"] as const) : []),
			"ollama",
			"qwen",
		];
		for (const family of families) {
			const authedIndexes = Object.keys(auth)
				.filter(
					(id) =>
						classifyProvider(id, config.qwenProvider) === family &&
						isEntryUsable(auth[id]),
				)
				.map(slotIndex);
			const wanted = new Set<number>(authedIndexes);
			if (
				family === "anthropic" ||
				family === "openai-codex" ||
				family === "kimi-coding" ||
				family === "cursor"
			) {
				let spare = 2;
				while (wanted.has(spare) && spare <= config.maxAccountsPerProvider)
					spare++;
				if (spare <= config.maxAccountsPerProvider) wanted.add(spare);
			}
			for (const index of wanted) {
				const id = slotId(family, index, config.qwenProvider);
				if (family === "cursor") {
					if (index <= 1) continue;
					if (!registeredSlots.has(id)) registeredSlots.add(id);
					continue;
				}
				if (index <= 1) continue;
				if (registeredSlots.has(id)) {
					if (!ctx || (family !== "ollama" && family !== "qwen")) continue;
					const base = family === "ollama" ? OLLAMA_BASE : config.qwenProvider;
					const signature = hostModelIdsFor(ctx, base).join(",");
					if (apiKeySlotHostSignature.get(id) === signature) continue;
					apiKeySlotHostSignature.set(id, signature);
				}
				if (family === "anthropic") {
					registerAnthropicSlot(
						pi,
						id,
						anthropicSlotModelIds(),
						numberedAnthropicBaseUrl(id),
					);
				} else if (family === "openai-codex") {
					const cached = codexModelCatalogByProvider.get(id)?.models;
					registerCodexSlot(
						pi,
						id,
						config.autoDiscoverModels && cached?.length
							? (cached as Array<Record<string, unknown>>)
							: undefined,
						numberedCodexBaseUrl(id),
					);
				} else if (family === "kimi-coding") {
					const kimiModels = [
						...new Set([...DEFAULT_KIMI_MODELS, ...hostModelIdsFor(ctx, KIMI_BASE)]),
					];
					registerKimiSlot(pi, id, kimiModels);
					if (ownsSharedChildPublication() && auth[id]?.type === "api_key" && isEntryUsable(auth[id])) {
						void publishNativeSlot(id, {
							api: "anthropic-messages",
							baseUrl: KIMI_BASE_URL,
							models: kimiModels.map((modelId) => kimiModelDef(modelId, id)),
						});
					}
				} else if (family === "ollama" || family === "qwen") {
					registerApiKeySlot(pi, id, family, config.qwenProvider, ctx);
				}
				registeredSlots.add(id);
			}
		}
		if (cursorAvailable) cursorReady = refreshCursorSlots(auth);
	}

	async function publishOwnedNativeAliases(ctx?: any): Promise<void> {
		if (!ownsSharedChildPublication()) return;
		const auth = readAuthFile();
		for (const id of registeredSlots) {
			if (classifyProvider(id, config.qwenProvider) !== "kimi-coding") continue;
			if (auth[id]?.type !== "api_key" || !isEntryUsable(auth[id])) continue;
			const kimiModels = [
				...new Set([...DEFAULT_KIMI_MODELS, ...hostModelIdsFor(ctx, KIMI_BASE)]),
			];
			await publishNativeSlot(id, {
				api: "anthropic-messages",
				baseUrl: KIMI_BASE_URL,
				models: kimiModels.map((modelId) => kimiModelDef(modelId, id)),
			});
		}
	}

	function reloadHostAuth(ctx: any) {
		try {
			ctx?.modelRegistry?.authStorage?.reload?.();
		} catch {
		}
	}

	function refreshDiscovery(force = false, ctx?: any): boolean {
		if (ctx) reloadHostAuth(ctx);
		const mtime = authMtimeMs();
		if (!force && mtime === lastAuthMtime) return false;
		lastAuthMtime = mtime;
		const auth = readAuthFile();
		let cooldownsCleared = false;
		for (const provider of new Set([
			...credentialHashes.keys(),
			...Object.keys(auth),
		])) {
			if (provider === "agy") continue;
			const entry = auth[provider];
			const nextHash = entry ? credentialHash(entry) : undefined;
			const previousHash = credentialHashes.get(provider);
			const nextIdentity = entry ? stableAccountFingerprint(entry) : undefined;
			const previousIdentity = credentialIdentities.get(provider);
			if (
				previousIdentity &&
				nextIdentity &&
				nextIdentity !== previousIdentity
			) {
				if (exhaustedUntilByProvider.delete(provider)) cooldownsCleared = true;
				if (codexModelCatalogByProvider.delete(provider)) cooldownsCleared = true;
				authFailures.delete(provider);
				exhaustedUntilByModel.forEach((_until, key) => {
					if (key.startsWith(`${provider}/`)) {
						exhaustedUntilByModel.delete(key);
						cooldownsCleared = true;
					}
				});
			}
			if (previousHash && nextHash !== previousHash) {
				usageByProvider.delete(provider);
				usageErrors.delete(provider);
				const refreshable =
					!!entry &&
					typeof entry.refresh === "string" &&
					entry.refresh.length > 0;
				if (!refreshable) authFailures.delete(provider);
			}
			if (nextHash) credentialHashes.set(provider, nextHash);
			else credentialHashes.delete(provider);
			if (nextIdentity) credentialIdentities.set(provider, nextIdentity);
			else credentialIdentities.delete(provider);
			const nextAuthType = authTypeOfEntry(entry);
			if (nextAuthType) {
				if (authTypeByProvider.get(provider) !== nextAuthType) {
					authTypeByProvider.set(provider, nextAuthType);
					cooldownsCleared = true;
				}
			} else if (authTypeByProvider.delete(provider)) {
				cooldownsCleared = true;
			}
		}
		for (const provider of [...authTypeByProvider.keys()]) {
			if (!Object.hasOwn(auth, provider)) {
				authTypeByProvider.delete(provider);
				cooldownsCleared = true;
			}
		}
		if (cooldownsCleared) persist();
		clearReauthedInvalidations(auth);
		syncRegisteredSlots(auth, ctx);
		if (ctx) {
			refreshRegistryCodexModels(ctx);
			refreshRegistryAnthropicModels(ctx);
		}
		duplicateSlots = discoverDuplicateSlots(auth);
		rotation = discoverRotation(auth);
		return true;
	}

	function activeFallbacks(): string[] {
		const auth = readAuthFile();
		const source = config.autoDiscover
			? [...configuredFallbacks, ...rotation]
			: configuredFallbacks.length > 0
				? configuredFallbacks
				: rotation;
		const result: string[] = [];
		const seenTargets = new Set<string>();
		const seenAccounts = new Set<string>();
		for (const target of source) {
			const parsed = parseTarget(target);
			if (!parsed) continue;
			const normalized = parsed.modelId
				? `${parsed.provider}/${parsed.modelId}`
				: parsed.provider;
			if (seenTargets.has(normalized)) continue;
			const entry = auth[parsed.provider];
			const identity = entry ? accountIdentity(entry) : undefined;
			if (identity && seenAccounts.has(identity)) continue;
			seenTargets.add(normalized);
			if (identity) seenAccounts.add(identity);
			result.push(normalized);
		}
		return result;
	}


	function providerHasUsableAuth(
		ctx: any,
		provider: string,
		auth: Record<string, AuthEntry> = readAuthFile(),
	) {
		const entry = auth[provider];
		if (entry) return isEntryUsable(entry);
		try {
			return (
				ctx.modelRegistry.authStorage?.hasAuth?.(provider) ??
				ctx.modelRegistry.getProviderAuthStatus?.(provider)?.configured ??
				true
			);
		} catch {
			return true;
		}
	}


	function familyPreferredModels(family: string | undefined): string[] {
		if (!family) return [];
		const configured = config.preferredModels[family];
		if (configured && configured.length > 0) return configured;
		const defaults =
			family === "anthropic"
				? registryAnthropicModelOrder.length > 0
					? registryAnthropicModelOrder
					: DEFAULT_ANTHROPIC_MODELS
				: family === "openai-codex"
					? discoveredCodexModelOrder.length > 0
						? discoveredCodexModelOrder
						: registryCodexModelOrder.length > 0
							? registryCodexModelOrder
							: DEFAULT_CODEX_MODELS
					: family === "kimi-coding"
						? DEFAULT_KIMI_MODELS
						: family === "ollama"
							? DEFAULT_OLLAMA_MODELS
							: family === "qwen"
								? DEFAULT_QWEN_MODELS
								: family === "cursor"
									? DEFAULT_CURSOR_MODELS
									: [];
		const last = lastModelByFamily[family];
		if (!last) return defaults;
		return [last, ...defaults.filter((id) => id !== last)];
	}

	function pinnedModelForProvider(provider: string): string | undefined {
		const scope = accountGroup(provider, config.qwenProvider);
		return Object.hasOwn(config.pinnedModels, scope) ? config.pinnedModels[scope] : undefined;
	}

	function savedDefaultForProvider(provider: string): string | undefined {
		const selected = readHostDefaultModel();
		return selected && accountGroup(selected.provider, config.qwenProvider) === accountGroup(provider, config.qwenProvider)
			? selected.id
			: undefined;
	}

	function pinQualityCompatible(model: any, source: any): boolean {
		const pin = pinnedModelForProvider(model.provider);
		const sourceBand = modelQualityBand(source?.id, source?.provider);
		return !pin || !sameModelIdentity(model.id, pin) || !sourceBand || modelQualityBand(model.id, model.provider) === sourceBand;
	}

	function preferredModelsForProvider(provider: string): string[] {
		const order = familyPreferredModels(classifyProvider(provider, config.qwenProvider));
		const pin = pinnedModelForProvider(provider);
		return pin ? [pin, ...order.filter(id => !sameModelIdentity(id, pin))] : order;
	}

	function modelRecencyRank(model: any): number {
		const order = preferredModelsForProvider(String(model?.provider ?? ""));
		const idx = order.findIndex((id) => sameModelIdentity(id, model?.id));
		return idx < 0 ? Number.MAX_SAFE_INTEGER : idx;
	}

	function isAccountChatModel(model: any): boolean {
		return !!model && model.api !== "pi-virtual" &&
			(!model.type || model.type === "chat");
	}

	function resolveTargets(
		ctx: any,
		target: string,
		currentModel: any,
		preferredOnly = false,
		ignoreSavedDefault = false,
	) {
		const parsed = parseTarget(target);
		if (!parsed) return [];
		if (parsed.modelId) {
			const model = findModelIncludingHidden(ctx, parsed.provider, parsed.modelId);
			return isAccountChatModel(model) ? [model] : [];
		}

		const selected = !ignoreSavedDefault && !pinnedModelForProvider(parsed.provider) && savedDefaultForProvider(parsed.provider);
		if (selected) {
			const model = findModelIncludingHidden(ctx, parsed.provider, selected);
			return isAccountChatModel(model) ? [model] : [];
		}

		const family = classifyProvider(parsed.provider, config.qwenProvider);
		const currentFamily = currentModel?.provider
			? classifyProvider(currentModel.provider, config.qwenProvider)
			: undefined;
		const sameFamily = !!family && !!currentFamily && family === currentFamily;
		const preferred = preferredModelsForProvider(parsed.provider);
		const keepCurrent = sameFamily && currentModel?.id ? [currentModel.id] : [];
		const usePreferredOnly = preferredOnly && preferred.length > 0 && !pinnedModelForProvider(parsed.provider);
		const registryModels = usePreferredOnly
			? []
			: [
					...ctx.modelRegistry
						.getAll()
						.filter((model: any) => model.provider === parsed.provider),
					...(hiddenProviderModels.get(parsed.provider) ?? []),
				].map((model: any) => model.id);
		const modelIds = config.preferLatestModel || pinnedModelForProvider(parsed.provider)
			? [...preferred, ...keepCurrent, ...registryModels]
			: [...keepCurrent, ...preferred, ...registryModels];
		const result: any[] = [];
		const seen = new Set<string>();
		for (const modelId of modelIds) {
			if (seen.has(modelId)) continue;
			const model = findModelIncludingHidden(ctx, parsed.provider, modelId);
			if (!isAccountChatModel(model)) {
				seen.add(modelId);
				continue;
			}
			if (seen.has(model.id)) continue;
			seen.add(modelId);
			seen.add(model.id);
			result.push(model);
		}
		return result;
	}

	function explicitlyAllowsPaidApexFallback(model: any, currentModel: any): boolean {
		const provider = String(model?.provider ?? "");
		const base = baseProviderId(provider);
		if (base !== "openai" && base !== "openrouter") return true;
		if (provider === currentModel?.provider) return true;
		return configuredFallbacks.some((target) => {
			const parsed = parseTarget(target);
			return parsed?.provider === provider &&
				(parsed.modelId === undefined || sameModelIdentity(parsed.modelId, model?.id));
		});
	}

	function findFallbackModels(
		ctx: any,
		currentModel: any,
		options: {
			availableNowOnly?: boolean;
			includeCurrent?: boolean;
			manualRoundRobin?: boolean;
			excludeProviders?: Set<string>;
			preserveQualityBand?: boolean;
			ignoreSavedDefault?: boolean;
			preferSameIdentity?: boolean;
		} = {},
	) {
		reconcileCooldownsFromUsage(ctx);
		pruneCooldowns();
		refreshRegistryCodexModels(ctx);
		refreshRegistryAnthropicModels(ctx);
		const fallbacks = activeFallbacks();
		if (fallbacks.length === 0) return [];

		const now = Date.now();

		type Scored = ScoredRouteCandidate<any>;
		const scored: Scored[] = [];
		const seen = new Set<string>();

		for (let i = 0; i < fallbacks.length; i++) {
			let models = resolveTargets(ctx, fallbacks[i], currentModel, false, options.ignoreSavedDefault === true).filter(
				(model: any) =>
					!options.excludeProviders?.has(model.provider) &&
					!isInvalidated(model.provider) &&
					providerHasUsableAuth(ctx, model.provider),
			);
			const sourceBand = modelQualityBand(currentModel?.id, currentModel?.provider);
			const sourceExceptional = apexIdentity(currentModel?.id);
			models = models.filter((model: any) => {
				if (!pinQualityCompatible(model, currentModel)) return false;
				if (!options.ignoreSavedDefault && !pinnedModelForProvider(model.provider) && sameModelIdentity(model.id, savedDefaultForProvider(model.provider))) {
					return explicitlyAllowsPaidApexFallback(model, currentModel);
				}
				const candidateBand = modelQualityBand(model.id, model.provider);
				const candidateExceptional = apexIdentity(model.id);
				if (candidateExceptional && candidateBand !== "apex") {
					return sourceExceptional === candidateExceptional &&
						sourceBand === undefined &&
						sameModelIdentity(model.id, currentModel?.id);
				}
				if (sourceBand === "apex") {
					return candidateBand === "apex" && explicitlyAllowsPaidApexFallback(model, currentModel);
				}
				if (candidateBand === "apex") return false;
				return !options.preserveQualityBand || !sourceBand || candidateBand === sourceBand;
			});
			if (models.length === 0) continue;
			const notModelCooled = (model: any) =>
				(exhaustedUntilByModel.get(`${model.provider}/${model.id}`) ?? 0) <= now;
			const flagshipPick = models.find(notModelCooled) ?? models[0];
			const currentId = currentModel?.id as string | undefined;
			const sameFamily =
				!!currentModel?.provider &&
				accountGroup(models[0].provider, config.qwenProvider) ===
					accountGroup(currentModel.provider, config.qwenProvider);
			const identityPick =
				options.preferSameIdentity !== false && sameFamily && currentId
					? models.find(
							(model: any) =>
								notModelCooled(model) &&
								sameModelIdentity(model.id, currentId),
						)
					: undefined;
			let pick = flagshipPick;
			if (identityPick) {
				const flagRank = modelRecencyRank(flagshipPick);
				const idRank = modelRecencyRank(identityPick);
				const pinRepresentative = sameModelIdentity(pinnedModelForProvider(flagshipPick.provider), flagshipPick.id);
				const upgrade =
					config.preferLatestModel &&
					!pinRepresentative &&
					idRank !== Number.MAX_SAFE_INTEGER &&
					flagRank < idRank;
				pick = upgrade ? flagshipPick : identityPick;
			}
			if (
				!options.includeCurrent &&
				pick.provider === currentModel?.provider &&
				(pick.id === currentModel?.id ||
					sameModelIdentity(pick.id, currentModel?.id))
			)
				continue;
			if (seen.has(pick.provider)) continue;
			seen.add(pick.provider);

			const key = `${pick.provider}/${pick.id}`;
			const providerUntil = providerRecoveryAt(pick.provider, now);
			const modelUntil = exhaustedUntilByModel.get(key) ?? 0;
			const remaining = Math.max(0, Math.max(providerUntil, modelUntil) - now);
			const group = accountGroup(pick.provider, config.qwenProvider);
			const currentGroup = currentModel?.provider
				? accountGroup(currentModel.provider, config.qwenProvider)
				: "";
			scored.push({
				model: pick,
				provider: pick.provider,
				remaining,
				rotIndex: i,
				rank: modelRecencyRank(pick),
				lastRefusalAt: limitStreakByProvider.get(pick.provider)?.lastAt ?? 0,
				confirmed: isConfirmedAvailable(pick.provider, now),
				predictedBusy:
					providerRecoveryAt(pick.provider, now, { ignoreCeiling: true }) >
					now,
				group,
				sameFamily: !!currentGroup && group === currentGroup,
				sameModel:
					!!currentGroup &&
					group === currentGroup &&
					sameModelIdentity(pick.id, currentModel?.id),
			});
		}
		if (scored.length === 0) return [];

		if (options.manualRoundRobin) {
			const n = fallbacks.length;
			const currentRotIndex = currentModel?.provider
				? fallbacks.findIndex(
						(t) => parseTarget(t)?.provider === currentModel.provider,
					)
				: -1;
			const forwardDistance = (rotIndex: number) =>
				currentRotIndex < 0
					? rotIndex
					: (rotIndex - currentRotIndex + n) % n || n;
			const byDistance = (a: Scored, b: Scored) =>
				forwardDistance(a.rotIndex) - forwardDistance(b.rotIndex);
			let ordered = [...scored].sort(byDistance);
			if (
				lastLeftProvider &&
				now - lastLeftAt < ANTI_PINGPONG_MS &&
				ordered.length > 1 &&
				ordered[0].model.provider === lastLeftProvider
			) {
				ordered = [...ordered.slice(1), ordered[0]];
			}
			const readyElsewhere = (s: Scored) =>
				s.remaining === 0 &&
				!usageUntrusted(s.provider, now) &&
				s.provider !== currentModel?.provider;
			return ordered.filter(readyElsewhere).map((s) => s.model);
		}

		return rankAutomaticRouteCandidates(scored, {
			preferLatestModel: config.preferLatestModel,
			preferSameIdentity: options.preferSameIdentity !== false,
			providerPriority: config.providerPriority,
			availableNowOnly: options.availableNowOnly === true,
			lastLeftProvider,
			lastLeftAt,
			antiPingPongMs: ANTI_PINGPONG_MS,
			now,
		});
	}

	/**
	 * Say where a manual selection actually landed, and what we believe about that account.
	 *
	 * `next` walks the ring regardless of cooldowns, so it can legitimately land on an account we
	 * think is spent. Saying so turns a confusing silent double-switch — land on a cooled account,
	 * get moved off it a second later — into one honest sentence, and it also reserves the one
	 * attempt that lets the user prove our bookkeeping wrong.
	 */
	function announceManualChoice(ctx: any) {
		const model = ctx.model;
		if (!model?.provider || !model?.id) return;
		pinManualChoice(model.provider);
		const now = Date.now();
		const until = providerRecoveryAt(model.provider, now, {
			ignoreCeiling: true,
		});
		const spent = until > now;
		ctx.ui.notify(
			spent
				? `pi-multi-account: switched to ${model.provider}/${model.id} — its quota forecast still says spent (~${formatUntil(until)}), but a forecast is not a verdict: it is tried right now, and re-checked at least every ${formatDelay(config.maxRecheckIntervalMs)} regardless`
				: `pi-multi-account: switched to ${model.provider}/${model.id}`,
			"info",
		);
	}

	function isFailoverExempt(provider: string | undefined): boolean {
		return !!provider &&
			!classifyProvider(provider, config.qwenProvider) &&
			config.neverFailoverProviders.includes(provider);
	}

	async function activateFallback(
		ctx: any,
		sourceModel: any,
		candidates: any[],
		reason: string,
		options: { armContinuation?: boolean; manual?: boolean } = {},
	) {
		if (!options.manual && (isFailoverExempt(sourceModel?.provider) || isFailoverExempt(ctx.model?.provider))) return false;
		const activationEpoch = chainEpoch;
		const stale = () => sessionClosed || activationEpoch !== chainEpoch || (!options.manual && (userAbortedChain || ctx.signal?.aborted));
		if (options.manual) resetGovernor();
		else if (!allowAction("account switch", ctx)) return false;
		const from =
			sourceModel?.provider && sourceModel?.id
				? ref(sourceModel.provider, sourceModel.id)
				: ("unavailable/account" as ModelRef);
		const failedProviders = new Set<string>();
		for (const fallback of candidates) {
			if (stale()) return false;
			if (failedProviders.has(fallback.provider)) continue;
			const to = ref(fallback.provider, fallback.id);
			if (to === from) {
				if (options.manual && candidates.length === 1) {
					modelPreferenceChanged = true;
					rememberUserModel(sourceModel);
					return true;
				}
				markExhausted(fallback.provider, config.transientCooldownMs);
				failedProviders.add(fallback.provider);
				continue;
			}
			let ok = true;
			if (
				ctx.model?.provider !== fallback.provider ||
				ctx.model?.id !== fallback.id
			) {
				automaticModelTarget = to;
				try {
					ok = await setModelEnsuringVisible(fallback, ctx);
				} catch {
					ok = false;
				}
				if (!ok && automaticModelTarget === to)
					automaticModelTarget = undefined;
			}
			if (stale()) return false;
			if (!ok) {
				reloadHostAuth(ctx);
				refreshDiscovery(true, ctx);
				if (providerHasUsableAuth(ctx, fallback.provider)) {
					automaticModelTarget = to;
					try {
						ok = await setModelEnsuringVisible(fallback, ctx);
					} catch {
						ok = false;
					}
					if (!ok && automaticModelTarget === to)
						automaticModelTarget = undefined;
				}
			}
			if (stale()) return false;
			if (!ok) {
				ctx.ui.notify(
					`Provider failover: ${to} could not be activated; skipping it briefly`,
					"warning",
				);
				markExhausted(fallback.provider, config.transientCooldownMs);
				failedProviders.add(fallback.provider);
				continue;
			}
			if (stale()) return false;
			if (options.manual) {
				modelPreferenceChanged = true;
				rememberUserModel(ctx.model ?? fallback);
			}
			restoreDesiredThinking(ctx);
			applyOnlyActiveFilter(ctx, fallback.provider);
			setLastProbe(fallback.provider);
			if (options.armContinuation !== false) {
				pinFailoverProbe(fallback.provider);
			}
			const warmupId =
				!options.manual && options.armContinuation !== false
					? await startFailoverWarmup(ctx, fallback)
					: undefined;
			if (stale()) return false;
			const record = { from, to, reason, at: Date.now() };
			currentPromptSwitch =
				options.armContinuation === false ? undefined : record;
			logEvent("switch", { session: sessionInstanceId, from, to, reason });
			pi.appendEntry("provider-failover", record);
			persist({
				lastSwitches: [record, ...(persistedState.lastSwitches ?? [])].slice(
					0,
					20,
				),
			});
			ctx.ui.notify(
				`Provider failover [v${VERSION}]: ${from} → ${to} (${reason})` +
					(warmupId ? `; first call on ${fallback.provider}/${warmupId}, then ${fallback.id}` : ""),
				"warning",
			);
			return true;
		}
		return false;
	}

	/**
	 * Run the first call after an automatic failover on the account group's configured warm-up
	 * model. Returns the warm-up id when it is now active; the switch otherwise stays on `target`.
	 */
	async function startFailoverWarmup(ctx: any, target: { provider: string; id: string }) {
		pendingWarmupUpgrade = undefined;
		const configured =
			config.failoverWarmupModels[accountGroup(target.provider, config.qwenProvider)];
		if (!configured || sameModelIdentity(configured, target.id)) return undefined;
		const warmup = findModelIncludingHidden(ctx, target.provider, configured);
		if (!warmup) {
			logEvent("failover_warmup_skipped", {
				provider: target.provider,
				model: configured,
				reason: "model not available on this account",
			});
			return undefined;
		}
		const warmupRef = ref(target.provider, warmup.id);
		automaticWarmupTarget = warmupRef;
		let ok = false;
		try {
			ok = await setModelEnsuringVisible(warmup, ctx);
		} catch {
			ok = false;
		}
		if (!ok) {
			if (automaticWarmupTarget === warmupRef) automaticWarmupTarget = undefined;
			logEvent("failover_warmup_skipped", {
				provider: target.provider,
				model: warmup.id,
				reason: "setModel failed",
			});
			return undefined;
		}
		restoreDesiredThinking(ctx);
		pendingWarmupUpgrade = {
			provider: target.provider,
			warmupId: warmup.id,
			target: { provider: target.provider, id: target.id },
		};
		logEvent("failover_warmup", { warmup: warmupRef, then: ref(target.provider, target.id) });
		return warmup.id as string;
	}

	/** After the warm-up call succeeded, move the route to the model the failover chose. */
	async function finishFailoverWarmup(ctx: any, message: any) {
		const pending = pendingWarmupUpgrade;
		if (
			!pending ||
			message?.provider !== pending.provider ||
			!sameModelIdentity(String(message?.model ?? ""), pending.warmupId)
		)
			return;
		pendingWarmupUpgrade = undefined;
		if (
			ctx.model?.provider !== pending.provider ||
			!sameModelIdentity(String(ctx.model?.id ?? ""), pending.warmupId)
		)
			return;
		const target =
			findModelIncludingHidden(ctx, pending.target.provider, pending.target.id) ?? pending.target;
		const targetRef = ref(pending.target.provider, pending.target.id);
		automaticModelTarget = targetRef;
		let ok = false;
		try {
			ok = await setModelEnsuringVisible(target, ctx);
		} catch {
			ok = false;
		}
		if (!ok) {
			if (automaticModelTarget === targetRef) automaticModelTarget = undefined;
			logEvent("failover_warmup_upgrade_failed", { target: targetRef });
			ctx.ui.notify(`Provider failover: could not switch from warm-up ${pending.warmupId} to ${targetRef}`, "warning");
			return;
		}
		restoreDesiredThinking(ctx);
		logEvent("failover_warmup_done", { from: ref(pending.provider, pending.warmupId), to: targetRef });
		ctx.ui.notify(`Provider failover: warm-up call done on ${pending.warmupId}; next calls use ${targetRef}`, "info");
	}

	async function switchToFallback(
		ctx: any,
		failedModel: any,
		reason: string,
		cooldownMs = config.cooldownMs,
		options: {
			manual?: boolean;
			scope?: "provider" | "model";
			excludeProviders?: Iterable<string>;
			allowFailedRouteResume?: boolean;
			/** This failure is real quota evidence; if no route is ready, use the separate wait option. */
			waitForQuotaRecovery?: boolean;
		} = {},
	) {
		if (!isAccountChatModel(failedModel) || (ctx.model && !isAccountChatModel(ctx.model))) return false;
		if (!options.manual && (isFailoverExempt(failedModel?.provider) || isFailoverExempt(ctx.model?.provider))) return false;
		const warmup = pendingWarmupUpgrade;
		pendingWarmupUpgrade = undefined;
		if (
			warmup &&
			failedModel?.provider === warmup.provider &&
			sameModelIdentity(String(failedModel?.id ?? ""), warmup.warmupId)
		)
			failedModel = findModelIncludingHidden(ctx, warmup.target.provider, warmup.target.id) ?? warmup.target;
		const switchEpoch = chainEpoch;
		if (!automaticFailoverEnabled() || !failedModel?.provider || !failedModel?.id)
			return false;

		if (options.scope === "model") {
			markModelExhausted(failedModel, cooldownMs);
		} else {
			markExhausted(failedModel.provider, cooldownMs);
			lastLeftProvider = failedModel.provider;
			lastLeftAt = Date.now();
		}

		if (
			!options.manual &&
			autoContinuesThisPrompt >= config.maxAutoContinuesPerPrompt
		) {
			ctx.ui.notify(
				`Provider failover: stopped after ${autoContinuesThisPrompt} auto-continues. Send a new message or run /multi-account reset to retry.`,
				"warning",
			);
			return false;
		}

		const excludeProviders = new Set<string>(options.excludeProviders ?? []);
		if (/auth (invalid|failure)/i.test(reason)) {
			excludeProviders.add(failedModel.provider);
		}
		const candidates = findFallbackModels(ctx, failedModel, {
			availableNowOnly: !options.manual,
			manualRoundRobin: options.manual,
			excludeProviders: excludeProviders.size > 0 ? excludeProviders : undefined,
			preserveQualityBand: true,
		});
		if (candidates.length === 0) {
			if (
				options.allowFailedRouteResume !== false &&
				armSameAccountResumeIfReady(ctx, failedModel, reason, options)
			)
				return false;
			const cooldowns = [...exhaustedUntilByProvider.entries()]
				.filter(
					([provider, until]) => until > Date.now() && !isInvalidated(provider),
				)
				.map(([provider, until]) => `${provider}: ${cooldownStatus(cachedUsage(provider), until, Date.now())}`)
				.join(", ");
			const invalids = [...invalidatedByProvider.keys()].join(", ");
			const availability = [
				cooldowns ? `Cooldowns: ${cooldowns}` : undefined,
				invalids ? `Invalidated (need re-login): ${invalids}` : undefined,
			]
				.filter(Boolean)
				.join(". ");
			logEvent("no_fallback", {
				after: `${failedModel.provider}/${failedModel.id}`,
				availability: availability || "none",
			});
			ctx.ui.notify(
				`Provider failover: no immediately available fallback after ${failedModel.provider}/${failedModel.id}. ${availability || "All known accounts may be unauthenticated, invalidated, or duplicate slots."}`,
				"warning",
			);
			const shouldWait = options.waitForQuotaRecovery
				? config.resumeAfterAllAccountsRecover
				: config.autoContinue;
			if (
				!options.manual &&
				shouldWait &&
				options.allowFailedRouteResume !== false
			)
				setPendingContinuation(ctx, failedModel, reason, {
					mode: options.waitForQuotaRecovery
						? "quota-recovery"
						: "auto-continue",
				});
			return false;
		}

		const switched = await activateFallback(
			ctx,
			failedModel,
			candidates,
			reason,
			{ armContinuation: !options.manual, manual: options.manual },
		);
		if (switchEpoch !== chainEpoch || userAbortedChain || ctx.signal?.aborted) return false;
		if (
			!switched &&
			!options.manual &&
			config.autoContinue &&
			options.allowFailedRouteResume !== false
		) {
			if (!armSameAccountResumeIfReady(ctx, failedModel, reason, options))
				setPendingContinuation(ctx, failedModel, reason);
		}
		return switched;
	}

	function armSameAccountResumeIfReady(
		ctx: any,
		failedModel: any,
		reason: string,
		options: { manual?: boolean } = {},
	): boolean {
		if (options.manual || !config.autoContinue) return false;
		reconcileCooldownsFromUsage(ctx);
		pruneCooldowns();
		if (!isCurrentModelReady(ctx)) return false;
		const target = ref(failedModel.provider, failedModel.id);
		currentPromptSwitch = {
			from: target,
			to: target,
			reason: `${reason} (same account recovered)`,
			at: Date.now(),
		};
		return true;
	}

	function isCurrentModelReady(ctx: any) {
		const model = ctx.model;
		if (!model?.provider || !model?.id) return false;
		if (
			!providerHasUsableAuth(ctx, model.provider) ||
			isInvalidated(model.provider)
		)
			return false;
		const now = Date.now();
		return (
			providerRecoveryAt(model.provider, now) <= now &&
			(exhaustedUntilByModel.get(ref(model.provider, model.id)) ?? 0) <= now
		);
	}

	/**
	 * One line per account that is cooling down, and when the first of them returns. Absolute UTC
	 * time next to the relative one: the status line is read hours later, "in 3h" no longer means
	 * anything by then.
	 */
	function exhaustedAccountsSummary(now: number): { text: string; firstReturnAt: number } {
		const cooling = [...exhaustedUntilByProvider.entries()]
			.filter(([provider, until]) => until > now && !isInvalidated(provider))
			.sort((a, b) => a[1] - b[1]);
		const firstReturnAt = cooling[0]?.[1] ?? now;
		const parts = cooling.map(
			([provider, until]) =>
				`${provider} returns in ${formatResetDuration(until, now)} (${new Date(until).toISOString().slice(0, 16)}Z)`,
			);
		return { text: parts.join("; "), firstReturnAt };
	}

	/**
	 * Last line of defence for a turn nobody typed. A turn that starts while the selected
	 * account is cooling down and no other account is ready can only re-collect the refusal we
	 * already hold, once per turn; abort it before it reaches the provider and keep the wait armed.
	 * A user prompt keeps its probe (the `input` hook lets it through on purpose, because a stale
	 * forecast is only ever found out that way), so this applies to turns started by anything else.
	 */
	function gateExhaustedTurn(ctx: any, userProbe: boolean): boolean {
		if (userProbe || subagentChild || !automaticFailoverEnabled()) return false;
		const model = ctx.model;
		if (!model?.provider || !model?.id || !isAccountChatModel(model) || isFailoverExempt(model.provider)) return false;
		pruneCooldowns();
		const now = Date.now();
		const cooling =
			providerRecoveryAt(model.provider, now) > now ||
			(exhaustedUntilByModel.get(ref(model.provider, model.id)) ?? 0) > now;
		if (!cooling || hasManualPin(model.provider) || hasFailoverPin(model.provider)) {
			exhaustedGateNoticeKey = undefined;
			return false;
		}
		if (
			findFallbackModels(ctx, model, {
				availableNowOnly: true,
				includeCurrent: true,
				preserveQualityBand: true,
			}).length > 0
		) {
			return false;
		}
		if (typeof ctx.abort !== "function") return false;
		const summary = exhaustedAccountsSummary(now);
		logEvent("turn_gated_exhausted", {
			session: sessionInstanceId,
			provider: model.provider,
			model: model.id,
			firstReturnAt: new Date(summary.firstReturnAt).toISOString(),
		});
		const key = `${summary.firstReturnAt}|${summary.text.replace(/returns in [^(]*/g, "")}`;
		if (key !== exhaustedGateNoticeKey) {
			exhaustedGateNoticeKey = key;
			ctx.ui.notify(
				`Provider failover: every account is exhausted, so no request was sent. ${summary.text}. The work resumes by itself when the first one returns.`,
				"error",
			);
		}
		if (!hasPendingResume() && config.resumeAfterAllAccountsRecover) {
			setPendingContinuation(ctx, model, "all accounts exhausted: waiting for quota recovery", {
				mode: "quota-recovery",
				quiet: true,
			});
		}
		exhaustedGateAborting = true;
		try {
			ctx.abort();
		} catch {
			exhaustedGateAborting = false;
			return false;
		}
		return true;
	}

	function rememberUserModel(model: { provider?: string; id?: string } | undefined) {
		if (
			subagentChild ||
			hostOwnsSessionModel ||
			!model?.provider ||
			!model?.id ||
			(!modelPreferenceChanged && !thinkingPreferenceChanged)
		)
			return;
		const rememberedModel = modelPreferenceChanged
			? { provider: model.provider, id: model.id }
			: persistedState.lastUserModel;
		if (!rememberedModel?.provider || !rememberedModel.id) return;
		if (modelPreferenceChanged) {
			const family = classifyProvider(model.provider, config.qwenProvider);
			if (family) lastModelByFamily[family] = model.id;
		}
		persist(
			{
				lastUserModel: rememberedModel,
				lastUserThinkingLevel: thinkingPreferenceChanged
					? desiredThinkingLevel ?? readThinkingLevel()
					: persistedState.lastUserThinkingLevel,
				lastModelByFamily: { ...lastModelByFamily },
			},
			{ writeUserPreferences: true },
		);
	}

	function intendedStartupModel(): { provider: string; id: string } | undefined {
		if (hostOwnsSessionModel) return startupModel;
		const remembered = persistedState.lastUserModel;
		if (remembered?.provider && remembered?.id) return remembered;
		return readHostDefaultModel();
	}

	async function restoreRememberedModel(ctx: any) {
		if (subagentChild) {
			logEvent("remembered_model_skipped", { reason: "pi-subagents child owns model selection" });
			return false;
		}
		if (explicitCli.model) {
			logEvent("remembered_model_skipped", { reason: "explicit CLI model" });
			return false;
		}
		const cliThinkingLevel = explicitCli.thinking
			? (explicitCliThinkingLevel ?? readThinkingLevel())
			: undefined;
		const intended = intendedStartupModel();
		if (!intended) {
			logEvent("remembered_model_skipped", { reason: "no intended model" });
			return false;
		}
		const alreadyThere =
			ctx.model?.provider === intended.provider &&
			ctx.model?.id === intended.id;
		if (alreadyThere) {
			if (explicitCli.thinking) desiredThinkingLevel = cliThinkingLevel ?? desiredThinkingLevel;
			restoreDesiredThinking(ctx);
			return true;
		}
		if (cursorReady) {
			await cursorReady.catch(() => undefined);
		}
		let found = findModelIncludingHidden(
			ctx,
			intended.provider,
			intended.id,
		);
		if (!found || !providerHasUsableAuth(ctx, intended.provider)) {
			logEvent("remembered_model_unavailable", {
				provider: intended.provider,
				model: intended.id,
				reason: !found ? "not in registry" : "no auth",
			});
			return false;
		}
		const from =
			ctx.model?.provider && ctx.model?.id
				? ref(ctx.model.provider, ctx.model.id)
				: "none";
		const to = ref(intended.provider, intended.id);
		if (explicitCli.thinking) {
			desiredThinkingLevel = cliThinkingLevel ?? desiredThinkingLevel;
		} else if (!hostOwnsSessionModel) {
			const rememberedLevel = persistedState.lastUserThinkingLevel;
			if (rememberedLevel) desiredThinkingLevel = rememberedLevel as ReasoningLevel;
		}
		automaticModelTarget = to;
		let ok = false;
		try {
			ok = await setModelEnsuringVisible(found, ctx);
		} catch {
			ok = false;
		}
		if (automaticModelTarget === to) automaticModelTarget = undefined;
		logEvent("remembered_model_restored", {
			from,
			to,
			ok,
			source: persistedState.lastUserModel ? "state" : "settings",
		});
		if (ok) {
			// external: Pi resets thinking level when changing models.
			if (explicitCli.thinking) {
				desiredThinkingLevel = cliThinkingLevel ?? desiredThinkingLevel;
			} else if (config.reasoningLevel === "auto" && hostOwnsSessionModel) {
				desiredThinkingLevel = readThinkingLevel();
				thinkingClamp = undefined;
			}
			restoreDesiredThinking(ctx);
			ctx.ui?.notify?.(
				`pi-multi-account: restored ${to} after catalog load (Pi had fallen back to ${from})`,
				"info",
			);
		}
		return ok;
	}

	async function ensureReadyModel(ctx: any, reason: string) {
		if (ctx.model && !isAccountChatModel(ctx.model)) return true;
		if (subagentChild || isFailoverExempt(ctx.model?.provider)) return true;
		refreshDiscovery(false, ctx);
		pruneCooldowns();
		const intended = intendedStartupModel();
		const onIntended =
			!!intended &&
			ctx.model?.provider === intended.provider &&
			ctx.model?.id === intended.id;
		// external: Pi can restore a fallback model when Cursor is not registered in time.
		if (!hostOwnsSessionModel && intended && !onIntended) {
			await restoreRememberedModel(ctx);
		}
		if (isFailoverExempt(ctx.model?.provider) || isCurrentModelReady(ctx)) return true;
		if (hasManualPin(ctx.model?.provider)) {
			markManualPinUsed(ctx.model?.provider);
			return true;
		}
		if (hasFailoverPin(ctx.model?.provider)) {
			markFailoverPinUsed(ctx.model?.provider);
			return true;
		}
		const candidates = findFallbackModels(ctx, ctx.model, {
			availableNowOnly: true,
			includeCurrent: true,
			preserveQualityBand: true,
		});
		if (candidates.length === 0) return false;
		return activateFallback(ctx, ctx.model, candidates, reason, {
			armContinuation: false,
		});
	}


	function hasPendingResume(): boolean {
		return !!pendingResume;
	}

	function pendingResumeEnabled(
		pending = pendingResume,
	): boolean {
		if (!pending) return false;
		return pending.mode === "quota-recovery"
			? config.resumeAfterAllAccountsRecover
			: config.autoContinue;
	}

	function withTimeout<T>(
		p: Promise<T>,
		ms: number,
		label: string,
		onTimeout?: () => void,
	): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				try {
					onTimeout?.();
				} catch {
				}
				reject(new Error(`${label} timed out after ${formatDelay(ms)}`));
			}, ms);
			timer.unref?.();
			p.then(
				(v) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve(v);
				},
				(e) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					reject(e);
				},
			);
		});
	}

	function abortQuietly(controller?: AbortController) {
		try {
			controller?.abort();
		} catch {
		}
	}

	function isContextOverflowError(text: string): boolean {
		if (!text.trim()) return false;
		return patternMatch(text, DEFAULT_IGNORE_PATTERNS);
	}

	function isBreakerOpen(): boolean {
		return breakerOpenUntil > Date.now();
	}

	function clearTransientFailureStreak() {
		transientFailureStreak = undefined;
	}

	function clearCursorStallFailureHistory() {
		cursorStallFailuresByRoute.clear();
	}

	function noteCursorStallFailure(model: { provider: string; id: string }): number {
		const route = ref(model.provider, model.id);
		const count = (cursorStallFailuresByRoute.get(route)?.count ?? 0) + 1;
		cursorStallFailuresByRoute.set(route, { provider: model.provider, count });
		logEvent("cursor_stall_failure", {
			session: sessionInstanceId,
			route,
			count,
		});
		return count;
	}

	function noteTransientFailure(model: { provider: string; id: string }): number {
		const route = ref(model.provider, model.id);
		transientFailureStreak =
			transientFailureStreak?.route === route
				? { route, count: transientFailureStreak.count + 1 }
				: { route, count: 1 };
		logEvent("transient_failure", {
			session: sessionInstanceId,
			route,
			count: transientFailureStreak.count,
		});
		return transientFailureStreak.count;
	}

	// external: Pi has its own provider retry loop.
	function noteProviderResponseStarted() {
		if (hasPendingResume()) clearPendingContinuation();
	}

	function noteRecoveryProgress() {
		clearTransientFailureStreak();
		if (hasPendingResume()) clearPendingContinuation();
		if (recoveryFailures !== 0 || breakerOpenUntil !== 0) {
			const wasOpen = breakerOpenUntil > Date.now();
			recoveryFailures = 0;
			breakerOpenUntil = 0;
			if (wasOpen) logEvent("breaker_close", { reason: "forward progress" });
		}
	}

	function noteRecoveryFailure(ctx: any) {
		recoveryFailures++;
		logEvent("recovery_failure", { count: recoveryFailures });
		if (recoveryFailures >= BREAKER_FAILURE_THRESHOLD && !isBreakerOpen()) {
			breakerOpenUntil = Date.now() + config.breakerCooldownMs;
			logEvent("breaker_open", {
				failures: recoveryFailures,
				cooldownMs: config.breakerCooldownMs,
			});
			ctx?.ui?.notify?.(
				`pi-multi-account [v${VERSION}]: automatic resume failed ${recoveryFailures}× in a row, so it is pausing auto-continue for ${formatDelay(config.breakerCooldownMs)} (safe mode) and then retries by itself. ` +
					"Temporary errors do not change your provider or model. Confirmed quota limits retain their separate failover policy. A new message or /multi-account reset retries immediately.",
				"warning",
			);
		}
	}

	function clearProgressWatchdog() {
		if (progressWatchdogTimer) {
			clearTimeout(progressWatchdogTimer);
			progressWatchdogTimer = undefined;
		}
	}

	function armStuckWatchdog() {
		clearProgressWatchdog();
		if (!activeResumeWatch || !automaticFailoverEnabled()) return;
		progressWatchdogTimer = setTimeout(
			onResumeStuck,
			Math.max(25, config.stuckWatchdogMs),
		);
		progressWatchdogTimer.unref?.();
	}

	function noteResumeProgress() {
		if (!activeResumeWatch) return;
		lastResumeProgressAt = Date.now();
		stuckReminders = 0;
		armStuckWatchdog();
	}

	function beginResumeWatch(ctx: any): () => void {
		const owner = Symbol("resume watch");
		activeResumeWatch = owner;
		watchdogCtx = ctx;
		lastResumeProgressAt = Date.now();
		stuckReminders = 0;
		toolInFlight = 0;
		armStuckWatchdog();
		return () => {
			if (activeResumeWatch === owner) endResumeWatch();
		};
	}

	function endResumeWatch() {
		activeResumeWatch = undefined;
		watchdogCtx = undefined;
		stuckReminders = 0;
		toolInFlight = 0;
		clearProgressWatchdog();
	}

	function onResumeStuck() {
		progressWatchdogTimer = undefined;
		if (!activeResumeWatch) return;
		// external: An uncaught timer callback exception can terminate the Pi process.
		try {
			const ctx = watchdogCtx;
			if (toolInFlight > 0) {
				armStuckWatchdog();
				return;
			}
			const previousAbortUnanswered = watchdogAborting;
			if (previousAbortUnanswered) {
				watchdogAborting = false;
				logEvent("resume_abort_unanswered", { silentMs: Date.now() - lastResumeProgressAt });
			}
			const silentMs = Date.now() - lastResumeProgressAt;
			const where = ctx?.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: "the active account";
			logEvent("resume_stuck", {
				model: where,
				silentMs,
				action: config.autoRecoverStuck !== false ? "auto_cancel" : "notify",
			});
			let recovery = "";
			try {
				const status = nextRecoveryStatus(ctx);
				if (status) recovery = ` (next recovery ${status})`;
			} catch {
			}

			noteRecoveryFailure(ctx);
			if (
				config.autoRecoverStuck !== false &&
				!previousAbortUnanswered &&
				typeof ctx?.abort === "function"
			) {
				ctx?.ui?.notify?.(
					`Provider retry [v${VERSION}]: the resumed turn on ${where} has been silent for ${formatDelay(silentMs)} — auto-cancelling this attempt; bounded recovery stays on the SAME provider and model. (/multi-account stop to cancel, /multi-account status to inspect.)`,
					"warning",
				);
				watchdogAborting = true;
				try {
					ctx.abort();
				} catch {
					watchdogAborting = false;
				}
				if (watchdogAborting) {
					progressWatchdogTimer = setTimeout(
						onResumeStuck,
						Math.max(25, config.stuckWatchdogMs) * ABORT_REPORT_GRACE_WINDOWS,
					);
					progressWatchdogTimer.unref?.();
					return;
				}
			}

			ctx?.ui?.notify?.(
				`Provider failover: the resumed turn on ${where} has shown no activity for ${formatDelay(silentMs)} and looks stuck${recovery}. ` +
					"Press Esc to cancel it, then /multi-account next to rotate, or /compact to shrink the context.",
				"warning",
			);
			stuckReminders++;
			if (stuckReminders < 5 && activeResumeWatch) {
				progressWatchdogTimer = setTimeout(
					onResumeStuck,
					Math.max(25, STUCK_REMINDER_MS),
				);
				progressWatchdogTimer.unref?.();
			}
		} catch {
		}
	}

	type CompactFn = (
		preparation: unknown,
		model: unknown,
		apiKey: string | undefined,
		headers: Record<string, string> | undefined,
		customInstructions: string | undefined,
		signal: AbortSignal | undefined,
		thinkingLevel: unknown,
	) => Promise<any>;

	async function resolveCompactFn(): Promise<CompactFn | undefined> {
		if (Object.prototype.hasOwnProperty.call(pi, "__testCompactFn")) {
			const injected = (pi as any).__testCompactFn;
			return typeof injected === "function" ? (injected as CompactFn) : undefined;
		}
		const mod = (await import("@earendil-works/pi-coding-agent").catch(
			() => undefined,
		)) as { compact?: CompactFn } | undefined;
		return typeof mod?.compact === "function" ? mod.compact : undefined;
	}

	function compactionCancelled(reason: string): {
		cancel: true;
		reason: string;
	} {
		compactionRoutedNote = reason;
		return { cancel: true, reason };
	}

	/** Accounts a recent compaction refusal has benched for a reason that needs a human. */
	const compactionUnfitUntil = new Map<string, number>();

	function compactionUnfit(provider: string, now = Date.now()): boolean {
		const until = compactionUnfitUntil.get(provider);
		if (until === undefined) return false;
		if (until > now) return true;
		compactionUnfitUntil.delete(provider);
		return false;
	}

	function noteCompactionRefusal(provider: string, error: string) {
		const text = error.toLowerCase();
		if (!COMPACTION_UNFIT_PATTERNS.some((pattern) => text.includes(pattern)))
			return;
		compactionUnfitUntil.set(provider, Date.now() + COMPACTION_UNFIT_MS);
	}

	function compactionCandidates(ctx: any): any[] {
		const now = Date.now();
		return findFallbackModels(ctx, ctx.model, {
			availableNowOnly: true,
			includeCurrent: false,
		}).filter(
			(model: any) =>
				model &&
				!compactionUnfit(model.provider, now) &&
				!isCursorProviderId(model.provider) &&
				!(
					model.provider === ctx.model?.provider &&
					model.id === ctx.model?.id
				),
		);
	}

	function cursorFamilyProviderIds(ctx: any, extra?: string): Set<string> {
		const ids = new Set<string>();
		if (extra && isCursorProviderId(extra)) ids.add(extra);
		for (const model of ctx?.modelRegistry?.getAll?.() ?? []) {
			if (
				typeof model?.provider === "string" &&
				isCursorProviderId(model.provider)
			) {
				ids.add(model.provider);
			}
		}
		return ids;
	}

	async function runHealthyCompaction(
		event: any,
		ctx: any,
	): Promise<
		{ compaction: any } | { cancel: true; reason: string } | undefined
	> {
		let recoveryLease: AutomaticRecoveryLease | undefined;
		let retainRecoveryLease = false;
		try {
			if (!automaticFailoverEnabled() || !config.routeCompactionToHealthyAccount)
				return undefined;
			const currentReady = isCurrentModelReady(ctx);
			const currentIsCursor = isCursorProviderId(ctx.model?.provider ?? "");
			if (currentReady && !currentIsCursor) {
				compactionRoutedNote = undefined;
				return undefined;
			}
			const preparation = event?.preparation;
			if (!preparation) return undefined;
			if (event?.signal?.aborted) {
				return compactionCancelled("compaction aborted");
			}
			const compactFn = await resolveCompactFn();
			const candidates = compactionCandidates(ctx);
			if (candidates.length === 0) {
				ctx.ui?.notify?.(
					currentIsCursor
						? "Provider failover: Cursor cannot summarize without hanging, and no other live account is available; cancelled instead of compacting on Cursor."
						: "Provider failover: no live account can summarize; cancelled instead of hanging on the spent account.",
					"warning",
				);
				return compactionCancelled(
					currentIsCursor
						? "no non-Cursor account for compaction; cancelled"
						: "no live account for compaction; cancelled",
				);
			}
			const parentLease = contextGuardRecoveryLease ?? continuationRecoveryLease;
			recoveryLease = recoveryArbiter.tryAcquire(
				{
					category: "context_limit",
					provider: ctx?.model?.provider,
					model: ctx?.model?.id,
					sessionId: recoverySessionId(ctx),
				},
				parentLease,
			);
			if (!recoveryLease) return compactionCancelled("another automatic recovery is active");
			recoveryLease.markRecovering("context_limit", ctx?.model?.provider, ctx?.model?.id);
			let thinkingLevel: any;
			try {
				thinkingLevel = (pi as any).getThinkingLevel?.();
			} catch {
			}
			const timeoutMs = Math.max(1, config.compactionWatchdogMs);
			const tried: string[] = [];
			let attempts = 0;
			for (const model of candidates) {
				if (event?.signal?.aborted) {
					return compactionCancelled("compaction aborted");
				}
				if (attempts >= COMPACTION_MAX_ATTEMPTS) {
					logEvent("compaction_attempts_capped", {
						attempts,
						skipped: candidates
							.slice(candidates.indexOf(model))
							.map((m: any) => m.provider),
					});
					break;
				}
				const auth = await ctx.modelRegistry?.getApiKeyAndHeaders?.(model);
				if (!auth?.ok || (!auth.apiKey && !auth.headers)) {
					tried.push(`${model.provider} (no auth)`);
					continue;
				}
				const isCurrent =
					model.provider === ctx.model?.provider &&
					model.id === ctx.model?.id;
				if (!isCurrent) {
					ctx.ui?.notify?.(
						currentIsCursor
							? `Provider failover: summarizing on ${model.provider} instead of Cursor, which stalls during compaction.`
							: `Provider failover: ${ctx.model?.provider ?? "active"} account is unavailable for compaction; summarizing on ${model.provider} instead.`,
						"info",
					);
				}
				if (typeof compactFn !== "function") {
					tried.push(`${model.provider} (host cannot compact)`);
					continue;
				}
				if (!allowAction("summarize on healthy account", ctx)) {
					return compactionCancelled("automatic recovery budget exhausted");
				}
				const attempt = new AbortController();
				const onParentAbort = () => abortQuietly(attempt);
				if (typeof event?.signal?.addEventListener === "function") {
					event.signal.addEventListener("abort", onParentAbort, {
						once: true,
					});
				}
				attempts++;
				try {
					const result = await withTimeout(
						compactFn(
							preparation,
							model,
							auth.apiKey,
							auth.headers,
							event?.customInstructions,
							attempt.signal,
							thinkingLevel,
						),
						timeoutMs,
						`compaction on ${model.provider}`,
						() => abortQuietly(attempt),
					);
					if (
						result &&
						typeof result.summary === "string" &&
						result.summary.trim()
					) {
						// external: Pi can drop the accumulated summary when compaction has no prior history range.
						if (droppedPreviousSummary(result.summary, preparation.previousSummary)) {
							logEvent("compaction_summary_repaired", {
								provider: model.provider,
								previousSummaryChars: preparation.previousSummary.length,
								droppedSummaryChars: result.summary.length,
							});
							result.summary = restorePreviousSummary(
								result.summary,
								preparation.previousSummary,
							);
						}
						compactionRoutedNote = `compacted on ${model.provider}`;
						logEvent("compaction_routed", {
							to: model.provider,
							reason: event?.reason,
							from: ctx.model?.provider,
						});
						continuationRecoveryLease =
							contextGuardRecoveryLease ?? continuationRecoveryLease ?? recoveryLease;
						retainRecoveryLease = true;
						return { compaction: result };
					}
					tried.push(`${model.provider} (empty)`);
				} catch (error) {
					abortQuietly(attempt);
					if (isPolicyRefusal(error)) {
						stopAutomaticRecoveryForPolicyRefusal(ctx, model.provider, model.id);
						return compactionCancelled("provider policy refusal; automatic recovery stopped");
					}
					if (event?.signal?.aborted) {
						return compactionCancelled("compaction aborted");
					}
					tried.push(`${model.provider} (${String(error).slice(0, 80)})`);
					noteCompactionRefusal(model.provider, String(error));
					logEvent("compaction_failed", {
						error: String(error),
						provider: model.provider,
					});
				} finally {
					if (typeof event?.signal?.removeEventListener === "function") {
						event.signal.removeEventListener("abort", onParentAbort);
					}
				}
			}
			if (typeof compactFn !== "function") {
				ctx.ui?.notify?.(
					"Provider failover: the active account cannot compact and this Pi build cannot reroute the summary; cancelled instead of hanging.",
					"warning",
				);
				return compactionCancelled(
					"cannot route compaction on this host",
				);
			}
			const detail = tried.join("; ") || "no candidates";
			ctx.ui?.notify?.(
				`Provider failover: could not finish compaction on any live account (${detail.slice(0, 140)}); cancelled instead of hanging on the spent one.`,
				"warning",
			);
			return compactionCancelled(
				"healthy-account compaction failed; cancelled",
			);
		} catch (error) {
			if (isPolicyRefusal(error)) {
				stopAutomaticRecoveryForPolicyRefusal(ctx, ctx?.model?.provider, ctx?.model?.id);
				return compactionCancelled("provider policy refusal; automatic recovery stopped");
			}
			logEvent("compaction_failed", { error: String(error) });
			if (event?.signal?.aborted) {
				return compactionCancelled("compaction aborted");
			}
			ctx?.ui?.notify?.(
				`Provider failover: compaction routing failed (${String(error).slice(0, 100)}); cancelled instead of hanging.`,
				"warning",
			);
			return compactionCancelled(
				`healthy compaction failed: ${String(error).slice(0, 60)}`,
			);
		} finally {
			if (!retainRecoveryLease) recoveryLease?.release();
		}
	}

	async function injectContinuationPrompt(
		ctx: any,
		resumeFrom?: {
			from?: ModelRef;
			reason?: string;
			allowWhenAutoContinueDisabled?: boolean;
		},
	): Promise<boolean> {
		const source = currentPromptSwitch ?? resumeFrom;
		const blocked = !source
			? "no switch or resume context"
			: !config.autoContinue && !resumeFrom?.allowWhenAutoContinueDisabled
				? "autoContinue disabled"
				: userAbortedChain
					? "user aborted the chain"
					: ctx.signal?.aborted
						? "abort signal raised"
						: autoContinuesThisPrompt >= config.maxAutoContinuesPerPrompt
							? `auto-continue budget spent (${autoContinuesThisPrompt}/${config.maxAutoContinuesPerPrompt})`
							: typeof pi.sendUserMessage !== "function"
								? "host build has no pi.sendUserMessage"
								: undefined;
		if (blocked) {
			logEvent("continuation_injection_blocked", { reason: blocked });
			return false;
		}
		const to =
			currentPromptSwitch?.to ??
			(ctx.model
				? ref(ctx.model.provider, ctx.model.id)
				: "the active account");
		const sameModelRetry = source?.from === to;
		const basePrompt = sameModelRetry
			? resumeFrom?.allowWhenAutoContinueDisabled
				? `Provider quota recovery activated: ${to} is usable again after every compatible account was limited. Continue the interrupted task from where it stopped and do not restart the task from the beginning.`
				: `Provider retry activated: retrying ${to} after a temporary failure; no account or model switch occurred. Continue the interrupted task from where it stopped and do not restart the task from the beginning.`
			: config.continuationPrompt
					.replaceAll("{from}", String(source?.from ?? "the previous account"))
					.replaceAll("{to}", String(to))
					.replaceAll("{reason}", source?.reason ?? "provider failover");
		let note = "";
		if (config.preserveInterruptedContext) {
			try {
				note = interruptedTurnNote(ctx.sessionManager?.getBranch?.() ?? []);
			} catch {
				note = "The interrupted turn could not be inspected, so its handoff record is unavailable. Inspect the existing transcript and verify actual tool outcomes before repeating effects; do not assume nothing was lost.";
			}
		}
		const prompt = note ? `${basePrompt}

${note}` : basePrompt;
		try {
			expectingInjectedContinuation = true;
			// external: Pi rejects a continuation while the agent is already processing.
			await Promise.resolve(
				pi.sendUserMessage(prompt, {
					deliverAs: "followUp",
				}),
			);
			logEvent("continuation_injected", {
				session: sessionInstanceId,
				from: source?.from,
				to,
				sameModelRetry,
			});
			autoContinuesThisPrompt++;
			return true;
		} catch (error) {
			expectingInjectedContinuation = false;
			logEvent("continuation_injection_failed", {
				error: String(error).slice(0, 200),
			});
			return false;
		}
	}

	async function resumeWithExistingContext(
		ctx: any,
		resumeFrom?: {
			from?: ModelRef;
			reason?: string;
			allowWhenAutoContinueDisabled?: boolean;
		},
	): Promise<boolean> {
		const resumeEpoch = chainEpoch;
		if (sessionClosed || userAbortedChain || ctx.signal?.aborted) return false;
		if (!allowAction("resume the interrupted turn", ctx)) return false;
		const continueAgent = (
			pi as {
				continueAgent?: (options?: {
					stripErrorAssistant?: boolean;
				}) => Promise<void>;
			}
		).continueAgent;
		if (typeof continueAgent !== "function") {
			// external: Older Pi hosts do not expose continueAgent.
			if (await injectContinuationPrompt(ctx, resumeFrom)) return true;
			ctx.ui.notify(
				`Provider failover [v${VERSION}]: could not auto-resume this turn; send your message to continue on ${
					ctx.model
						? ref(ctx.model.provider, ctx.model.id)
						: "the active account"
				}. Run /multi-account status for the reason.`,
				"warning",
			);
			return false;
		}
		if (!ctx.isIdle()) {
			const waitUntil = Date.now() + config.resumeIdleTimeoutMs;
			while (!ctx.isIdle() && resumeEpoch === chainEpoch && !userAbortedChain && !ctx.signal?.aborted) {
				if (Date.now() >= waitUntil) {
					ctx.ui.notify(
						`Provider failover [v${VERSION}]: the previous turn did not go idle within ${formatDelay(config.resumeIdleTimeoutMs)}; auto-retrying the resume in the background.`,
						"warning",
					);
					const failed =
						ctx.model?.provider && ctx.model?.id ? ctx.model : undefined;
					if (failed && automaticFailoverEnabled() && config.autoContinue)
						setPendingContinuation(ctx, failed, BUSY_RETRY_REASON);
					return false;
				}
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		}
		if (sessionClosed || userAbortedChain || ctx.signal?.aborted) return false;
		if (resumeEpoch !== chainEpoch) return false;
		const stopResumeWatch = beginResumeWatch(ctx);
		logEvent("resume_start", {
			session: sessionInstanceId,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown",
			hop: autoContinuesThisPrompt + 1,
		});
		try {
			await continueAgent({ stripErrorAssistant: true });
			if (resumeEpoch !== chainEpoch) return false;
			autoContinuesThisPrompt++;
			logEvent("resume_ok", {
				session: sessionInstanceId,
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown",
			});
			return true;
		} catch (error) {
			if (resumeEpoch !== chainEpoch) return false;
			const text = String(error);
			if (
				watchdogAborting ||
				resumeEpoch !== chainEpoch ||
				userAbortedChain ||
				ctx.signal?.aborted ||
				/abort/i.test(text)
			) {
				return false;
			}
			// external: Pi cannot continue directly from a terminal assistant message.
			if (/cannot continue from message role/i.test(text)) {
				if (await injectContinuationPrompt(ctx, resumeFrom)) return true;
				return false;
			}
			noteRecoveryFailure(ctx);
			ctx.ui.notify(
				`Provider failover: could not resume with existing context (${text})`,
				"error",
			);
			return false;
		} finally {
			stopResumeWatch();
		}
	}

	function parkIfDispatchBudgetSpent(ctx: any, allowRecoveryResume: boolean, mode: PendingResumeMode) {
		if (autoContinuesThisPrompt < config.maxAutoContinuesPerPrompt) return;
		if (!config.autoContinue && !allowRecoveryResume) return;
		if (userAbortedChain || ctx.signal?.aborted || !currentPromptSwitch) return;
		if (!ctx.model?.provider || !ctx.model?.id) return;
		parkPendingResume(ctx, ctx.model, currentPromptSwitch.reason, mode);
	}

	function deferDispatchForBreaker(ctx: any, reason: string, allowRecoveryResume: boolean, mode: PendingResumeMode) {
		ctx.ui?.notify?.(
			`Provider failover: switched to ${ctx.model?.provider ?? "a fresh account"}; auto-continue resumes by itself in ~${formatDelay(breakerOpenUntil - Date.now())} (safe mode after repeated failures). A new message or /multi-account reset continues now.`,
			"warning",
		);
		if (!ctx.model?.provider || !ctx.model?.id) return;
		if (!config.autoContinue && !allowRecoveryResume) return;
		setPendingContinuation(ctx, ctx.model, reason || "safe mode after repeated failures", { mode, quiet: true });
	}

	async function maybeDispatchContinuation(
		ctx: any,
		options: {
			allowWhenAutoContinueDisabled?: boolean;
			pendingMode?: PendingResumeMode;
			recoveryLease?: AutomaticRecoveryLease;
		} = {},
	): Promise<boolean> {
		const allowRecoveryResume =
			options.allowWhenAutoContinueDisabled === true;
		if (
			(!config.autoContinue && !allowRecoveryResume) ||
			userAbortedChain ||
			ctx.signal?.aborted ||
			!currentPromptSwitch ||
			autoContinuesThisPrompt >= config.maxAutoContinuesPerPrompt
		) {
			parkIfDispatchBudgetSpent(ctx, allowRecoveryResume, options.pendingMode ?? "auto-continue");
			return false;
		}
		const dispatchSwitch = currentPromptSwitch;
		const recoveryCategory: RecoveryCategory = /quota|rate limit|cooldown|exhausted/i.test(dispatchSwitch.reason)
			? "quota"
			: /context|compact/i.test(dispatchSwitch.reason)
				? "context_limit"
				: /overload|transient|timeout|unavailable/i.test(dispatchSwitch.reason)
					? "transient"
					: "unknown";
		const recoveryLease = recoveryArbiter.tryAcquire(
			{
				category: recoveryCategory,
				provider: ctx?.model?.provider,
				model: ctx?.model?.id,
				sessionId: recoverySessionId(ctx),
			},
			options.recoveryLease,
		);
		if (!recoveryLease) return false;
		recoveryLease.markRecovering(recoveryCategory, ctx?.model?.provider, ctx?.model?.id);
		try {
		if (isBreakerOpen()) {
			deferDispatchForBreaker(ctx, dispatchSwitch.reason, allowRecoveryResume, options.pendingMode ?? "auto-continue");
			return false;
		}
		reconcileCooldownsFromUsage(ctx);
		pruneCooldowns();
		if (!isCurrentModelReady(ctx)) {
			const failed =
				ctx.model?.provider && ctx.model?.id ? ctx.model : undefined;
			if (failed && (config.autoContinue || allowRecoveryResume)) {
				setPendingContinuation(
					ctx,
					failed,
					dispatchSwitch.reason || "account is cooling down",
					{ mode: options.pendingMode ?? "auto-continue" },
				);
			}
			return false;
		}
		const resumed = await resumeWithExistingContext(ctx, {
			from: dispatchSwitch.from,
			reason: dispatchSwitch.reason,
			allowWhenAutoContinueDisabled: allowRecoveryResume,
		});
		if (resumed) {
			continuationDispatchedForAgentTurn = true;
			return true;
		}
		// external: Pi can asynchronously reject follow-up dispatch while the agent is busy.
		if (
			!hasPendingResume() &&
			currentPromptSwitch === dispatchSwitch &&
			!sessionClosed &&
			!userAbortedChain &&
			!ctx.signal?.aborted
		) {
			const failed =
				ctx.model?.provider && ctx.model?.id ? ctx.model : undefined;
			if (failed)
				setPendingContinuation(
					ctx,
					failed,
					`${SELECTED_FALLBACK_PENDING_PREFIX} ${dispatchSwitch.reason}`,
					{ mode: options.pendingMode ?? "auto-continue" },
				);
		}
		return false;
		} finally {
			if (!options.recoveryLease) recoveryLease.release();
		}
	}


	function noteProviderRequestObserved() {
		requestSignalSeen = true;
		actionsSinceRequest = 0;
		firstActionSinceRequestAt = 0;
	}

	function noteProviderSuccessObserved() {
		successSignalSeen = true;
		noteProviderRequestObserved();
		actionsSinceSuccess = 0;
	}

	function resetGovernor() {
		actionsSinceRequest = 0;
		actionsSinceSuccess = 0;
		firstActionSinceRequestAt = 0;
		governorStoppedReason = undefined;
	}

	function governorStopped(): boolean {
		return governorStoppedReason !== undefined;
	}

	function stopEverything(ctx: any, reason: string) {
		if (governorStopped()) return;
		governorStoppedReason = reason;
		chainEpoch++;
		userAbortedChain = true;
		currentPromptSwitch = undefined;
		watchdogAborting = false;
		expectingInjectedContinuation = false;
		startFreshFailoverChain();
		clearPendingContinuation();
		if (queuedInputWakeTimer) {
			clearTimeout(queuedInputWakeTimer);
			queuedInputWakeTimer = undefined;
		}
		clearProgressWatchdog();
		const heldNote = takeHeldMessagesNote();
		logEvent("governor_stopped", {
			reason,
			actionsSinceRequest,
			actionsSinceSuccess,
		});
		try {
			ctx?.ui?.notify?.(
				`pi-multi-account [v${VERSION}]: automatic failover has STOPPED itself — ${reason}. ` +
					"Nothing is retrying in the background any more. Run /multi-account status to see when an account recovers, " +
					"/multi-account next to pick one by hand, or just send a message: your next message re-enables everything." +
					heldNote,
				"error",
			);
		} catch {
		}
	}

	function takeHeldMessagesNote(): string {
		const held = queuedUserInputs
			.splice(0)
			.map((input) => input.text)
			.filter((text) => text.trim().length > 0);
		if (held.length === 0) return "";
		logEvent("held_messages_returned", { count: held.length });
		const what = held.length === 1 ? "message was" : `${held.length} messages were`;
		const which = held.length === 1 ? "it is" : "they are";
		return ` Your held ${what} not sent — here ${which}, to re-send: ${held
			.map((text) => JSON.stringify(text.slice(0, 200)))
			.join(" · ")}`;
	}

	function allowAction(kind: string, ctx: any): boolean {
		if (governorStopped()) return false;
		actionsSinceRequest++;
		actionsSinceSuccess++;
		if (firstActionSinceRequestAt === 0) firstActionSinceRequestAt = Date.now();
		if (
			requestSignalSeen &&
			actionsSinceRequest >= GOVERNOR_ACTIONS_WITHOUT_REQUEST
		) {
			const spanMs = Date.now() - firstActionSinceRequestAt;
			stopEverything(
				ctx,
				`${actionsSinceRequest} automatic steps in ${formatDelay(spanMs)} without a single request reaching a provider (last: ${kind})`,
			);
			return false;
		}
		if (
			successSignalSeen &&
			actionsSinceSuccess >= GOVERNOR_ACTIONS_WITHOUT_SUCCESS
		) {
			stopEverything(
				ctx,
				`${actionsSinceSuccess} automatic steps without one provider answering successfully (last: ${kind})`,
			);
			return false;
		}
		return true;
	}

	function clearPendingContinuation(options: { allowLegacy?: boolean } = {}) {
		if (pendingWakeTimer) {
			clearTimeout(pendingWakeTimer);
			pendingWakeTimer = undefined;
		}
		pendingResume = undefined;
		persistedState = {
			...persistedState,
			pendingContinuationPrompt: undefined,
			pendingFrom: undefined,
			pendingSince: undefined,
			pendingReason: undefined,
			pendingOwner: undefined,
		};
		persist(undefined, {
			clearPending: options.allowLegacy ? "owned-or-legacy" : "owned",
		});
	}

	function pendingWakeProviders(): string[] {
		if (isSameModelResumeReason(pendingResume?.reason ?? "")) {
			const parsed = pendingResume?.from
				? parseTarget(pendingResume.from)
				: undefined;
			return parsed?.provider && !isInvalidated(parsed.provider)
				? [parsed.provider]
				: [];
		}
		return [
			...new Set(
				activeFallbacks()
					.map((target) => parseTarget(target)?.provider)
					.filter((p): p is string => !!p),
			),
		].filter((provider) => !isInvalidated(provider));
	}

	function nextPendingWakeDelayMs(): number | undefined {
		const now = Date.now();
		const providers = pendingWakeProviders();
		if (providers.length === 0) return undefined;
		const nextAt = Math.min(
			...providers.map((p) => providerRecoveryAt(p, now)),
		);
		return Math.max(
			pendingWakeBackoffMs,
			nextAt - now,
			(pendingResume?.retryAt ?? now) - now,
			breakerOpenUntil - now,
		);
	}

	function growPendingWakeBackoff() {
		pendingWakeBackoffMs = Math.min(
			config.pendingPollMs,
			pendingWakeBackoffMs * 2,
		);
	}

	function resetPendingWakeBackoff() {
		pendingWakeBackoffMs = MIN_PENDING_WAKE_MS;
		pendingResumeHops = 0;
	}

	function startFreshFailoverChain() {
		resetPendingWakeBackoff();
	}

	function claimUserControl(reason: string, isExplicitUserControl = false) {
		chainEpoch++;
		if (isExplicitUserControl) {
			recoveryArbiter.resetForUserControl();
			clearContextGuardCompactionWait();
			releaseContextGuardRecovery();
			continuationRecoveryLease?.release();
			continuationRecoveryLease = undefined;
			contextGuardWantsCompaction = false;
			contextGuardContinuationPending = false;
		}
		if (reason.startsWith("manual")) manualRouteOwnsErrors = true;
		autoContinuesThisPrompt = 0;
		resetGovernor();
		startFreshFailoverChain();
		clearTransientFailureStreak();
		clearCursorStallFailureHistory();
		userAbortedChain = false;
		currentPromptSwitch = undefined;
		continuationDispatchedForAgentTurn = false;
		expectingInjectedContinuation = false;
		endResumeWatch();
		if (hasPendingResume()) clearPendingContinuation();
		logEvent("user_control_claimed", { session: sessionInstanceId, reason, epoch: chainEpoch });
	}

	function stopAutomaticRecoveryForPolicyRefusal(
		ctx: any,
		provider?: string,
		model?: string,
	) {
		const wasStopped = recoveryArbiter.policyRefusalStopped;
		if (wasStopped) return;
		recoveryArbiter.stopForPolicyRefusal({
			provider,
			model,
			sessionId: recoverySessionId(ctx),
		});
		contextGuardWantsCompaction = false;
		contextGuardContinuationPending = false;
		contextGuardCompactionRetryAfter =
			Date.now() + CONTEXT_GUARD_COMPACTION_FAILURE_BACKOFF_MS;
		clearContextGuardCompactionWait();
		try {
			ctx?.abort?.();
		} catch {
		}
		clearPendingContinuation();
		releaseContextGuardRecovery();
		continuationRecoveryLease?.release();
		continuationRecoveryLease = undefined;
		currentPromptSwitch = undefined;
		continuationDispatchedForAgentTurn = false;
		expectingInjectedContinuation = false;
		if (!wasStopped) {
			try {
				ctx?.ui?.notify?.(
					"Automatic provider recovery stopped after a policy refusal. Retry explicitly or send a new message to start a fresh recovery run.",
					"warning",
				);
			} catch {
			}
		}
	}

	function schedulePendingWake(ctx: any) {
		if (pendingWakeTimer) clearTimeout(pendingWakeTimer);
		pendingWakeTimer = undefined;
		if (
			governorStopped() ||
			!hasPendingResume() ||
			userAbortedChain ||
			!automaticFailoverEnabled() ||
			!pendingResumeEnabled()
		)
			return;
		const delay = nextPendingWakeDelayMs();
		if (delay === undefined) return;
		const epoch = chainEpoch;
		pendingWakeTimer = setTimeout(
			() => {
				pendingWakeTimer = undefined;
				if (epoch !== chainEpoch) return;
				runBackground("pending auto-resume", ctx, () =>
					attemptPendingResume(ctx),
				);
			},
			Math.min(delay, config.pendingPollMs),
		);
		pendingWakeTimer.unref?.();
	}

	function pendingResumeRecoveryLease(ctx: any, reason: string): AutomaticRecoveryLease | undefined {
		const category: RecoveryCategory = /quota|rate limit|exhausted|cooldown/i.test(reason)
			? "quota"
			: /context|compact/i.test(reason)
				? "context_limit"
				: /overload|transient|timeout|unavailable/i.test(reason)
					? "transient"
					: "unknown";
		const lease = recoveryArbiter.tryAcquire({
			category,
			provider: ctx?.model?.provider,
			model: ctx?.model?.id,
			sessionId: recoverySessionId(ctx),
		});
		if (lease) {
			lease.markRecovering(category, ctx?.model?.provider, ctx?.model?.id);
			continuationRecoveryLease = lease;
		} else logEvent("automatic_recovery_suppressed", { reason: "another automatic recovery is active" });
		return lease;
	}

	function releasePendingResumeRecoveryLease(lease: AutomaticRecoveryLease) {
		if (continuationRecoveryLease?.token === lease.token)
			continuationRecoveryLease = undefined;
		lease.release();
	}

	async function attemptPendingResume(ctx: any) {
		const epoch = chainEpoch;
		if (
			!hasPendingResume() ||
			userAbortedChain ||
			!automaticFailoverEnabled() ||
			!pendingResumeEnabled()
		)
			return;
		if (!ctx.isIdle() || isBreakerOpen()) {
			schedulePendingWake(ctx);
			return;
		}
		const parkedSource = pendingResume?.from ? parseTarget(pendingResume.from) : undefined;
		if (
			autoContinuesThisPrompt >= config.maxAutoContinuesPerPrompt ||
			pendingResumeHops >= config.maxAutoContinuesPerPrompt
		) {
			if (pendingResumeHops >= config.maxAutoContinuesPerPrompt)
				logEvent("pending_resume_exhausted", {
					hops: pendingResumeHops,
					budget: config.maxAutoContinuesPerPrompt,
				});
			parkPendingResume(
				ctx,
				parkedSource ?? ctx.model,
				pendingResume?.reason ?? "recovery budget spent",
				pendingResume?.mode ?? "auto-continue",
			);
			return;
		}
		refreshDiscovery();
		reconcileCooldownsFromUsage(ctx, {
			allowWhenHidden: pendingResume?.mode === "quota-recovery",
		});
		pruneCooldowns();
		const pendingSnapshot = pendingResume;
		const pendingMode = pendingSnapshot?.mode ?? "auto-continue";
		const allowRecoveryResume = pendingMode === "quota-recovery";
		const parsedFrom = pendingSnapshot?.from
			? parseTarget(pendingSnapshot.from)
			: undefined;
		const sourceModel = parsedFrom
			? {
					provider: parsedFrom.provider,
					id: parsedFrom.modelId ?? ctx.model?.id,
				}
			: ctx.model;
		if (!sourceModel?.provider || !sourceModel?.id ||
			isFailoverExempt(sourceModel.provider) || isFailoverExempt(ctx.model?.provider)) {
			clearPendingContinuation();
			return;
		}

		if (isSameModelResumeReason(pendingSnapshot?.reason ?? "")) {
			const now = Date.now();
			if (providerRecoveryAt(sourceModel.provider, now) <= now && (pendingSnapshot?.retryAt ?? now) <= now) {
				const resumeReason = pendingSnapshot?.reason ?? "";
				const recoveryLease = pendingResumeRecoveryLease(ctx, resumeReason);
				if (!recoveryLease) {
					schedulePendingWake(ctx);
					return;
				}
				try {
				clearPendingContinuation();
				const same = ref(sourceModel.provider, sourceModel.id);
				if (
					ctx.model?.provider !== sourceModel.provider ||
					ctx.model?.id !== sourceModel.id
				) {
					automaticModelTarget = same;
					if (onlyActiveModels) unhideProvider(sourceModel.provider);
					internalModelChanges++;
					try {
						await pi.setModel(
							ctx.modelRegistry.find(sourceModel.provider, sourceModel.id) ?? {
								provider: sourceModel.provider,
								id: sourceModel.id,
							},
						);
					} finally {
						internalModelChanges--;
						if (automaticModelTarget === same) automaticModelTarget = undefined;
					}
				}
				if (epoch !== chainEpoch || sessionClosed) return;
				const resumed = await resumeWithExistingContext(ctx, {
					from: same,
					reason: resumeReason,
					allowWhenAutoContinueDisabled: allowRecoveryResume,
				});
				if (
					!resumed &&
					!hasPendingResume() &&
					epoch === chainEpoch &&
					!sessionClosed &&
					!userAbortedChain
				) {
					setPendingContinuation(
						ctx,
						sourceModel,
						`${SELECTED_FALLBACK_PENDING_PREFIX} ${resumeReason ?? "retry continuation"}`,
						{ mode: pendingMode },
					);
				}
				return;
				} finally {
					releasePendingResumeRecoveryLease(recoveryLease);
				}
			}
			schedulePendingWake(ctx);
			return;
		}

		const pendingReason = pendingSnapshot?.reason ?? "";
		const now = Date.now();
		const sourceRef = ref(sourceModel.provider, sourceModel.id);
		const sourceRecovered =
			!isAuthPendingReason(pendingReason) &&
			providerRecoveryAt(sourceModel.provider, now) <= now &&
			(exhaustedUntilByModel.get(sourceRef) ?? 0) <= now &&
			providerHasUsableAuth(ctx, sourceModel.provider) &&
			!isInvalidated(sourceModel.provider);
		const candidates = findFallbackModels(ctx, sourceModel, {
			availableNowOnly: true,
			includeCurrent: false,
			preserveQualityBand: true,
			excludeProviders: isAuthPendingReason(pendingReason)
				? new Set<string>([sourceModel.provider])
				: undefined,
		});
		const otherCandidates = candidates.filter(
			(m: any) =>
				ref(m.provider, m.id) !== sourceRef &&
				providerRecoveryAt(m.provider, now) <= now &&
				(exhaustedUntilByModel.get(ref(m.provider, m.id)) ?? 0) <= now,
		);
		if (otherCandidates.length === 0) {
			if (sourceRecovered) {
				const recoveryLease = pendingResumeRecoveryLease(ctx, pendingReason);
				if (!recoveryLease) {
					schedulePendingWake(ctx);
					return;
				}
				try {
				clearPendingContinuation();
				if (epoch !== chainEpoch || sessionClosed) return;
				const resumed = await resumeWithExistingContext(ctx, {
					from: sourceRef,
					reason: pendingReason,
					allowWhenAutoContinueDisabled: allowRecoveryResume,
				});
				if (
					!resumed &&
					!hasPendingResume() &&
					epoch === chainEpoch &&
					!sessionClosed &&
					!userAbortedChain
				) {
					setPendingContinuation(
						ctx,
						sourceModel,
						`${SELECTED_FALLBACK_PENDING_PREFIX} ${pendingReason || "quota recovery"}`,
						{ mode: pendingMode },
					);
				}
				return;
				} finally {
					releasePendingResumeRecoveryLease(recoveryLease);
				}
			}
			growPendingWakeBackoff();
			schedulePendingWake(ctx);
			return;
		}

		const reason = pendingReason || "account cooldown expired";
		const recoveryLease = pendingResumeRecoveryLease(ctx, reason);
		if (!recoveryLease) {
			schedulePendingWake(ctx);
			return;
		}
		try {
			const switched = await activateFallback(
				ctx,
				sourceModel,
				otherCandidates,
				reason,
			);
			if (epoch !== chainEpoch) return;
			if (!switched || !currentPromptSwitch) {
				growPendingWakeBackoff();
				schedulePendingWake(ctx);
				return;
			}
			pendingResumeHops++;
			clearPendingContinuation();
			const dispatched = await maybeDispatchContinuation(ctx, {
				allowWhenAutoContinueDisabled: allowRecoveryResume,
				pendingMode,
				recoveryLease,
			});
			if (epoch !== chainEpoch) return;
			if (dispatched) resetPendingWakeBackoff();
			else growPendingWakeBackoff();
		} finally {
			releasePendingResumeRecoveryLease(recoveryLease);
		}
	}

	function setPendingContinuation(
		ctx: any,
		failedModel: any,
		reason: string,
		options: {
			mode?: PendingResumeMode;
			retryDelayMs?: number;
			notBeforeMs?: number;
			quiet?: boolean;
		} = {},
	) {
		if (governorStopped() || userAbortedChain) return;
		const from = ref(failedModel.provider, failedModel.id);
		const alreadyPending = hasPendingResume();
		const mode = options.mode ?? "auto-continue";
		pendingResume = {
			from,
			reason,
			mode,
			since: pendingResume?.since ?? Date.now(),
			retryAt: isTransientPendingReason(reason)
				? Date.now() + (options.retryDelayMs ?? config.transientCooldownMs)
				: options.notBeforeMs !== undefined
					? Date.now() + options.notBeforeMs
					: undefined,
		};
		logEvent("pending_resume_set", {
			session: sessionInstanceId,
			from,
			reason,
			mode,
		});
		persistedState = {
			...persistedState,
			pendingReason: reason,
			pendingFrom: from,
			pendingContinuationPrompt: undefined,
			pendingSince: pendingResume.since,
			pendingOwner: sessionInstanceId,
		};
		persist();
		const delay = nextPendingWakeDelayMs();
		if (delay === undefined) {
			clearPendingContinuation();
			if (!alreadyPending) {
				ctx.ui.notify(
					"Provider failover: no recoverable account is available; automatic resume is stopped.",
					"warning",
				);
			}
			return;
		}
		schedulePendingWake(ctx);
		if (!alreadyPending && !options.quiet) {
			const busy = isBusyRetryPendingReason(reason);
			const transient = isTransientPendingReason(reason);
			ctx.ui.notify(
				busy
					? `Provider failover [v${VERSION}]: the previous turn is still busy on ${failedModel.provider}/${failedModel.id}. Resuming the SAME model in ~${formatDelay(delay)} (re-checks every ${formatDelay(config.pendingPollMs)}) — it will not be downgraded. Esc, a new message, or /multi-account stop cancels it.`
					: transient
						? `Provider retry: temporary error on ${failedModel.provider}/${failedModel.id}. Retrying the SAME account and model in ~${formatDelay(delay)} (re-checks every ${formatDelay(config.pendingPollMs)}). Esc, a new message, or /multi-account stop cancels it.`
						: `Provider failover: all accounts are cooling down. This session will retry automatically in ~${formatDelay(delay)} (and re-checks every ${formatDelay(config.pendingPollMs)}). Esc during a run, a new user message, /multi-account stop, or leaving the session cancels it.`,
				"warning",
			);
		}
	}

	function retryTemporaryFailure(
		ctx: any,
		failedModel: { provider: string; id: string },
		errorText: string,
		retryDelayMs = config.transientCooldownMs,
	) {
		const cursorStall = isCursorProviderId(failedModel.provider) && isCursorUpstreamStall(errorText);
		const failures = cursorStall ? noteCursorStallFailure(failedModel) : noteTransientFailure(failedModel);
		if (continuationDispatchedForAgentTurn || activeResumeWatch) noteRecoveryFailure(ctx);
		currentPromptSwitch = undefined;
		clearPendingContinuation();
		if (cursorStall) logEvent("cursor_upstream_stall", {
			session: sessionInstanceId,
			provider: failedModel.provider,
			model: failedModel.id,
			consecutiveFailures: failures,
			error: errorText,
		});
		const slowDown = failures > BREAKER_FAILURE_THRESHOLD;
		const delayMs = slowDown
			? Math.min(
					TRANSIENT_RETRY_MAX_DELAY_MS,
					retryDelayMs * 2 ** Math.min(20, failures - 1 - BREAKER_FAILURE_THRESHOLD),
				)
			: retryDelayMs;
		if (failures === BREAKER_FAILURE_THRESHOLD + 1) {
			ctx.ui.notify(
				`Provider retry: ${failures} failed attempts on ${failedModel.provider}/${failedModel.id}; it keeps retrying by itself, slower each time (up to every ${formatDelay(TRANSIENT_RETRY_MAX_DELAY_MS)}). Provider and model were NOT changed; this is not quota exhaustion.`,
				"warning",
			);
		}
		if (!config.autoContinue) {
			ctx.ui.notify(`Provider retry: temporary error on ${failedModel.provider}/${failedModel.id}; automatic retry is disabled. Provider and model were NOT changed.`, "warning");
			return;
		}
		setPendingContinuation(
			ctx,
			failedModel,
			`${TRANSIENT_PENDING_PREFIX} ${errorText.slice(0, 120)}`,
			{ retryDelayMs: delayMs, quiet: slowDown },
		);
	}

	function parkPendingResume(ctx: any, model: { provider: string; id: string }, reason: string, mode: PendingResumeMode) {
		const spent = autoContinuesThisPrompt;
		const hops = pendingResumeHops;
		autoContinuesThisPrompt = 0;
		pendingResumeHops = 0;
		logEvent("pending_resume_parked", { autoContinues: spent, hops, delayMs: config.breakerCooldownMs });
		ctx.ui.notify(
			`Provider failover: recovery used its budget (${Math.max(spent, hops)} attempts); it resumes by itself in ~${formatDelay(config.breakerCooldownMs)}. A new message or /multi-account reset continues now.`,
			"warning",
		);
		setPendingContinuation(ctx, model, reason, { mode, notBeforeMs: config.breakerCooldownMs, quiet: true });
	}


	function clearQueuedInputs() {
		queuedWakeBackoffMs = AUTH_CHANGE_POLL_MS;
		if (queuedInputWakeTimer) {
			clearTimeout(queuedInputWakeTimer);
			queuedInputWakeTimer = undefined;
		}
		queuedUserInputs.length = 0;
	}

	function nextModelAvailabilityDelayMs(ctx: any): number | undefined {
		const candidates = findFallbackModels(ctx, ctx.model, {
			includeCurrent: true,
		});
		if (candidates.length === 0) return undefined;
		const now = Date.now();
		const nextAt = Math.min(
			...candidates.map((model: any) => {
				const modelUntil =
					exhaustedUntilByModel.get(ref(model.provider, model.id)) ?? now;
				return Math.max(providerRecoveryAt(model.provider, now), modelUntil);
			}),
		);
		return Math.max(MIN_PENDING_WAKE_MS, nextAt - now);
	}

	function queuedInputContent(input: { text: string; images?: any[] }) {
		if (!input.images?.length) return input.text;
		return [{ type: "text", text: input.text }, ...input.images];
	}

	function scheduleQueuedInputWake(ctx: any) {
		if (queuedInputWakeTimer) clearTimeout(queuedInputWakeTimer);
		if (
			governorStopped() ||
			queuedUserInputs.length === 0 ||
			userAbortedChain ||
			!automaticFailoverEnabled()
		) {
			queuedInputWakeTimer = undefined;
			return;
		}
		const availabilityDelay = nextModelAvailabilityDelayMs(ctx);
		if (availabilityDelay === undefined) {
			queuedInputWakeTimer = undefined;
			return;
		}
		const delay = Math.min(
			availabilityDelay,
			Math.max(AUTH_CHANGE_POLL_MS, queuedWakeBackoffMs),
		);
		queuedWakeBackoffMs = Math.min(
			config.pendingPollMs,
			Math.max(AUTH_CHANGE_POLL_MS, queuedWakeBackoffMs * 2),
		);
		const epoch = chainEpoch;
		queuedInputWakeTimer = setTimeout(() => {
			queuedInputWakeTimer = undefined;
			if (epoch !== chainEpoch) return;
			runBackground("queued input resume", ctx, () =>
				attemptQueuedInputResume(ctx),
			);
		}, delay);
		queuedInputWakeTimer.unref?.();
	}

	async function attemptQueuedInputResume(ctx: any) {
		const epoch = chainEpoch;
		if (
			queuedUserInputs.length === 0 ||
			userAbortedChain ||
			!automaticFailoverEnabled()
		)
			return;
		if (!ctx.isIdle()) {
			scheduleQueuedInputWake(ctx);
			return;
		}
		reconcileCooldownsFromUsage(ctx);
		const ready = await ensureReadyModel(
			ctx,
			"queued input: account became available",
		);
		if (epoch !== chainEpoch) return;
		if (!ready) {
			scheduleQueuedInputWake(ctx);
			return;
		}
		if (!allowAction("send a held message", ctx)) return;
		const count = queuedUserInputs.length;
		if (queuedInputWakeTimer) {
			clearTimeout(queuedInputWakeTimer);
			queuedInputWakeTimer = undefined;
		}
		logEvent("queued_input_flush_started", {
			count,
			provider: ctx.model?.provider,
			model: ctx.model?.id,
		});
		while (queuedUserInputs.length > 0) {
			const input = queuedUserInputs[0];
			// external: Pi accepts follow-up messages while idle or streaming.
			try {
				await pi.sendUserMessage(queuedInputContent(input), { deliverAs: "followUp" });
				queuedUserInputs.shift();
			} catch (error) {
				logEvent("queued_input_dispatch_failed", {
					remaining: queuedUserInputs.length,
					error: String(error).slice(0, 200),
				});
				scheduleQueuedInputWake(ctx);
				ctx.ui.notify(
					"Provider failover: the selected account is ready, but Pi did not accept the held message yet; it remains queued and will retry automatically.",
					"warning",
				);
				return;
			}
		}
		logEvent("queued_input_flushed", { count });
		ctx.ui.notify(
			`Provider failover: resumed ${count} queued message(s) on ${ctx.model.provider}/${ctx.model.id}.`,
			"info",
		);
	}

	async function resumeQueuedInputsAfterManualSwitch(ctx: any, switched: boolean) {
		if (!switched || queuedUserInputs.length === 0) return;
		userAbortedChain = false;
		await attemptQueuedInputResume(ctx);
	}


	function isAuthError(text: string) {
		if (!text.trim()) return false;
		if (patternMatch(text, config.ignoreErrorPatterns)) return false;
		return patternMatch(text, config.authErrorPatterns);
	}

	function isLimitError(text: string) {
		if (!text.trim()) return false;
		if (patternMatch(text, config.ignoreErrorPatterns)) return false;
		return patternMatch(text, config.limitErrorPatterns);
	}

	function isTransientError(text: string) {
		if (!text.trim()) return false;
		if (patternMatch(text, config.ignoreErrorPatterns)) return false;
		return patternMatch(text, config.transientErrorPatterns);
	}

	function isModelError(text: string) {
		if (!text.trim()) return false;
		if (patternMatch(text, config.ignoreErrorPatterns)) return false;
		return patternMatch(text, config.modelErrorPatterns);
	}

	function assistantErrorText(message: any) {
		const parts: string[] = [];
		if (typeof message?.errorMessage === "string")
			parts.push(message.errorMessage);
		for (const diagnostic of Array.isArray(message?.diagnostics)
			? message.diagnostics
			: []) {
			if (typeof diagnostic?.error?.message === "string")
				parts.push(diagnostic.error.message);
			if (diagnostic?.error?.code !== undefined)
				parts.push(String(diagnostic.error.code));
		}
		for (const block of Array.isArray(message?.content)
			? message.content
			: []) {
			if (block?.type === "text" && typeof block.text === "string")
				parts.push(block.text);
		}
		return [...new Set(parts.map((part) => part.trim()).filter(Boolean))].join(
			"\n",
		);
	}


	function clearProviderRuntimeState(provider: string) {
		invalidatedByProvider.delete(provider);
		exhaustedUntilByProvider.delete(provider);
		authFailures.delete(provider);
		usageByProvider.delete(provider);
		usageErrors.delete(provider);
		codexModelCatalogByProvider.delete(provider);
		credentialHashes.delete(provider);
		credentialIdentities.delete(provider);
		registeredSlots.delete(provider);
		for (const key of [...exhaustedUntilByModel.keys()]) {
			if (key.startsWith(`${provider}/`)) exhaustedUntilByModel.delete(key);
		}
	}

	async function removeAuthSlot(ctx: any, id: string, notifyFailure = true, refresh = true): Promise<boolean> {
		const raw = readAuthFileRaw();
		const sidecar = readProxyOAuthSidecar();
		if (!raw[id] && !sidecar[id]) return false;
		if (raw[id] && !(await removeCredentialFromAuthStorage(ctx?.modelRegistry?.authStorage, id))) {
			if (notifyFailure) ctx.ui.notify(
				"pi-multi-account: credential deletion failed; the account and its recovery copy were preserved.", "error");
			return false;
		}
		try {
			mutateProxyAuth(AUTH_PATH, PROXY_OAUTH_PATH, (auth, shadows) => {
				if (auth[id] || !shadows[id]) return { auth, sidecar: shadows, changed: false };
				const remaining = { ...shadows };
				delete remaining[id];
				return { auth, sidecar: remaining, changed: true };
			}, "restore");
		} catch { logEvent("auth_publication_deferred", { operation: "remove_shadow" }); }
		clearProviderRuntimeState(id);
		if (refresh) {
			persist();
			const wasCurrent = ctx.model?.provider === id;
			reloadHostAuth(ctx);
			refreshDiscovery(true, ctx);
			if (wasCurrent) await ensureReadyModel(ctx, `removed current account ${id}`);
		}
		return true;
	}

	function modelPinLines(ctx: any): string[] {
		const entries = Object.entries(config.pinnedModels).sort(([a], [b]) => a.localeCompare(b));
		if (!entries.length) return ["  none — /multi-account pin <provider/model>"];
		const models = [...ctx.modelRegistry.getAll(), ...[...hiddenProviderModels.values()].flat()];
		const now = Date.now();
		return entries.map(([scope, id]) => {
			const matching = models.filter((model: any) => accountGroup(model.provider, config.qwenProvider) === scope &&
				sameModelIdentity(model.id, id) && isAccountChatModel(model));
			const usable = matching.filter((model: any) => !isInvalidated(model.provider) && providerHasUsableAuth(ctx, model.provider));
			const sourceBand = modelQualityBand(ctx.model?.id, ctx.model?.provider);
			const compatible = usable.filter((model: any) => {
				const band = modelQualityBand(model.id, model.provider);
				if (sourceBand === "apex") return band === "apex" && explicitlyAllowsPaidApexFallback(model, ctx.model);
				return band !== "apex" && (!sourceBand || band === sourceBand) && (!apexIdentity(model.id) || sameModelIdentity(model.id, ctx.model?.id));
			});
			const free = compatible.filter((model: any) => providerRecoveryAt(model.provider, now) <= now &&
				(exhaustedUntilByModel.get(`${model.provider}/${model.id}`) ?? 0) <= now);
			const status = !matching.length ? "missing from catalog" : !usable.length ? "no usable account" :
				!compatible.length ? "incompatible with current quality band" : !free.length ? "cooling" : "preference available";
			return `  ${scope}: ${id} — ${status}`;
		});
	}

	async function handleCommand(args: string, ctx: any) {
		const inputProblem = commandArgumentsProblem(args);
		if (inputProblem) {
			ctx.ui.notify(inputProblem, "warning");
			return;
		}
		const parts = args.trim().split(/\s+/);
		const [commandRaw, arg1] = parts;
		const command = (commandRaw || "status").toLowerCase();

		if (command === "pins") {
			if (parts.length > 2 || (arg1 && arg1 !== "list")) {
				ctx.ui.notify("pi-multi-account: usage: /multi-account pins [list]", "warning");
				return;
			}
			ctx.ui.notify(["pi-multi-account model pins (routing preferences, not foreground selections):", ...modelPinLines(ctx),
				"Exact siblings, authentication, health and quality checks still apply. Other sessions adopt edits on reload/restart."].join("\n"), "info");
			return;
		}

		if (command === "pin" || command === "unpin") {
			const parsed = command === "pin" ? parseTarget(arg1) : undefined;
			const provider = command === "pin" ? parsed?.provider : arg1;
			if (parts.length !== 2 || !provider || !validModelPinScope(provider) ||
				(command === "pin" && (!parsed?.modelId || /\s/.test(parsed.modelId)))) {
				ctx.ui.notify("pi-multi-account: usage: /multi-account pin <provider/model> | unpin <provider-or-family> | pins [list]", "warning");
				return;
			}
			if (subagentChild || sessionClosed || !ctx.isIdle()) {
				ctx.ui.notify("pi-multi-account: change model pins from an idle live parent session; no preference was saved", "warning");
				return;
			}
			const epoch = chainEpoch;
			const selected = ctx.model ? ref(ctx.model.provider, ctx.model.id) : undefined;
			const session = ctx.sessionManager?.getSessionId?.();
			const canCommit = () => !subagentChild && !sessionClosed && ctx.isIdle() && epoch === chainEpoch &&
				(ctx.model ? ref(ctx.model.provider, ctx.model.id) : undefined) === selected && ctx.sessionManager?.getSessionId?.() === session;
			const scope = accountGroup(provider, config.qwenProvider);
			const modelId = parsed?.modelId;
			const exact = modelId ? findModelIncludingHidden(ctx, provider, modelId) : undefined;
			const known = modelId ? [exact, ...ctx.modelRegistry.getAll(), ...[...hiddenProviderModels.values()].flat()].filter((model: any) =>
				model && accountGroup(model.provider, config.qwenProvider) === scope && sameModelIdentity(model.id, modelId)) : [];
			if ((exact && !isAccountChatModel(exact)) || (known.length > 0 && !known.some(isAccountChatModel))) {
				ctx.ui.notify("pi-multi-account: only account chat models can be pinned; virtual/image/classifier models remain host-owned", "warning");
				return;
			}
			try {
				const pins = persistModelPin(CONFIG_PATH, scope, modelId, canCommit);
				config = { ...config, pinnedModels: pins };
				claimUserControl("model pin preference changed", true);
				logEvent("model_pin_set", { scope, model: modelId ?? null });
				ctx.ui.notify(command === "unpin"
					? `pi-multi-account: removed model pin for ${scope}; the underlying preferredModels/catalog order is unchanged`
					: `pi-multi-account: pinned ${scope}/${modelId} across sibling accounts.${known.length ? "" : " Saved but currently absent; inactive until the catalog supplies it."} Current model was not changed; select a cheaper tier explicitly. Other sessions adopt this preference on reload/restart.`,
					known.length || command === "unpin" ? "info" : "warning");
			} catch {
				ctx.ui.notify("pi-multi-account: model pin was not saved; check config syntax, permissions/lock and session ownership. Runtime preference is unchanged", "error");
			}
			return;
		}

		if (command === "log" || command === "logs" || command === "debug") {
			if (arg1 === "off") {
				config = { ...config, debugLog: false };
				debugLogEnabled = false;
				ctx.ui.notify(
					'pi-multi-account: debug logging disabled for this session. Set "debugLog": true in the config to re-enable permanently.',
					"info",
				);
				return;
			}
			if (arg1 === "on") {
				config = { ...config, debugLog: true };
				debugLogEnabled = true;
				logEvent("debug_enabled", { version: VERSION });
				ctx.ui.notify(
					`pi-multi-account: debug logging enabled. File: ${DEBUG_LOG_PATH}`,
					"info",
				);
				return;
			}
			const n = arg1 === undefined ? 40 : Number(arg1);
			const tail = readDebugLogTail(n);
			ctx.ui.notify(
				tail
					? `pi-multi-account debug log (last ${n} events) — ${DEBUG_LOG_PATH}\n${tail}`
					: `pi-multi-account: no debug log yet at ${DEBUG_LOG_PATH} (it fills as failover events happen; enable with /multi-account log on if needed).`,
				"info",
			);
			return;
		}

		if (command === "pick") {
			if (!ctx.hasUI || !ctx.model || !ctx.isIdle() || subagentChild || sessionClosed) {
				ctx.ui.notify("pi-multi-account: model picker needs an idle interactive session with an active model", "warning");
				return;
			}
			const provider = ctx.model.provider;
			const epoch = chainEpoch;
			const models = ctx.modelRegistry.getAvailable().filter((model: any) => model.provider === provider);
			const choices = [...new Set<string>(models.map((model: any) => model.id))].sort();
			if (!choices.length) {
				ctx.ui.notify(`pi-multi-account: no available models for ${provider}`, "warning");
				return;
			}
			const choice = await ctx.ui.select(`Models — ${provider}`, choices);
			if (!choice || sessionClosed || epoch !== chainEpoch || !ctx.isIdle() || ctx.model?.provider !== provider) return;
			const model = models.find((candidate: any) => candidate.id === choice);
			if (!model) return;
			if (await setModelEnsuringVisible(model, ctx)) {
				ctx.ui.notify(`pi-multi-account: selected ${provider}/${choice}; use /multi-account save-default to keep this model and thinking for new sessions`, "info");
			}
			return;
		}

		if (command === "save-default") {
			if (!ctx.model || !ctx.isIdle() || subagentChild || sessionClosed) {
				ctx.ui.notify("pi-multi-account: save defaults from an idle parent session with an active model", "warning");
				return;
			}
			const { provider, id } = ctx.model;
			const epoch = chainEpoch;
			const level = readThinkingLevel();
			if (!level) {
				ctx.ui.notify("pi-multi-account: host cannot report the active thinking level; defaults were not changed", "warning");
				return;
			}
			const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
			if (sessionClosed || epoch !== chainEpoch || !ctx.isIdle() ||
				ctx.model?.provider !== provider || ctx.model?.id !== id || readThinkingLevel() !== level) return;
			const settings = SettingsManager.create(ctx.cwd, AGENT_DIR, {
				projectTrusted: ctx.isProjectTrusted?.() ?? false,
			});
			settings.setDefaultModelAndProvider(provider, id);
			settings.setModelThinkingLevel(provider, id, level);
			await settings.flush();
			if (settings.drainErrors().length) {
				ctx.ui.notify("pi-multi-account: could not save all startup settings; check settings.json permissions and syntax", "error");
				return;
			}
			const overridden = settings.getDefaultProvider() !== provider || settings.getDefaultModel() !== id || settings.getModelThinkingLevel(provider, id) !== level;
			ctx.ui.notify(`pi-multi-account: saved global startup default ${provider}/${id} • ${level}.${overridden ? " Project settings override this choice in this workspace." : " Applies to new sessions; explicit CLI options and resumed sessions keep their own settings."}`, overridden ? "warning" : "info");
			return;
		}

		if (command === "models" || command === "model") {
			refreshDiscovery(false, ctx);
			const lines = [
				`pi-multi-account models (prefer-latest: ${config.preferLatestModel ? "ON" : "OFF"}) — ★ = selected first:`,
			];
			let listedAccounts = 0;
			for (const target of activeFallbacks()) {
				const parsed = parseTarget(target);
				if (!parsed) continue;
				listedAccounts++;
				const ordered = resolveTargets(ctx, target, ctx.model).map(
					(m: any, i: number) => (i === 0 ? `★${m.id}` : m.id),
				);
				lines.push(
					`  ${parsed.provider}: ${ordered.join(", ") || "(no models registered — check /login)"}`,
				);
			}
			if (listedAccounts === 0) {
				lines.push("  no accounts in rotation — run /login, then /multi-account rediscover");
			}
			const overrides = Object.entries(config.preferredModels);
			if (overrides.length > 0) {
				lines.push(
					`Config overrides: ${overrides.map(([fam, list]) => `${fam}=[${list.join(", ")}]`).join("; ")}`,
				);
			} else {
				lines.push(
					`Live Codex discovery: ${config.autoDiscoverModels ? `ON${discoveredCodexModelOrder.length ? ` — ${discoveredCodexModelOrder.join(" → ")}` : " — no cached catalog yet"}` : "OFF"}.`,
				);
			}
			ctx.ui.notify(lines.join("\n"), "info");
			return;
		}

		if (command === "reload") {
			const previousAutoDiscoverModels = config.autoDiscoverModels;
			config = loadConfig();
			if (config.onlyActive !== onlyActiveModels) {
				onlyActiveModels = config.onlyActive;
				if (onlyActiveModels) applyOnlyActiveFilter(ctx);
				else clearOnlyActiveFilter();
			}
			debugLogEnabled = config.debugLog;
			configuredFallbacks = config.fallbacks.slice();
			if (config.autoDiscoverModels !== previousAutoDiscoverModels) {
				registryCodexModelOrder = [];
				if (!config.autoDiscoverModels) {
					discoveredCodexModelOrder = [];
					discoveredOllamaModelIds = [];
					ollamaCatalogFetchedAt = 0;
				}
			}
			refreshDiscovery(true, ctx);
			startUsageStatusTimer(ctx);
			if (hasPendingResume()) {
				if (pendingResumeEnabled()) schedulePendingWake(ctx);
				else clearPendingContinuation();
			}
			runBackground("reload account metadata refresh", ctx, () =>
				refreshAccountMetadata(ctx, { usage: true, force: true }),
			);
			ctx.ui.notify(
				"pi-multi-account: config reloaded and accounts re-discovered",
				"info",
			);
			return;
		}
		if (command === "rediscover") {
			const changed = refreshDiscovery(true, ctx);
			runBackground("rediscover slot proxy republish", ctx, async () => {
				await publishProxiedSlots(ctx);
				await publishOwnedNativeAliases(ctx);
			});
			runBackground("rediscover account metadata refresh", ctx, () =>
				refreshAccountMetadata(ctx, { usage: true, force: true }),
			);
			ctx.ui.notify(
				`pi-multi-account: rediscovered accounts${changed ? "" : " (no auth.json change)"}. Rotation: ${rotation.join(" → ") || "none"}`,
				"info",
			);
			return;
		}
		if (command === "add") {
			const family = parseFamilyArg(arg1);
			if (!family) {
				ctx.ui.notify(
					"pi-multi-account: usage: /multi-account add <anthropic|codex|kimi|cursor|ollama|qwen>",
					"warning",
				);
				return;
			}
			const auth = readAuthFile();
			let n = 2;
			while (
				auth[slotId(family, n, config.qwenProvider)] &&
				n <= config.maxAccountsPerProvider
			)
				n++;
			if (n > config.maxAccountsPerProvider) {
				ctx.ui.notify(
					`pi-multi-account: no free ${family} slot (max ${config.maxAccountsPerProvider}). Remove an unused one from auth.json first.`,
					"warning",
				);
				return;
			}
			const id = slotId(family, n, config.qwenProvider);
			if (family === "cursor" && !isCursorProviderInstalled()) {
				await refreshCursorSlots(auth, ctx, true);
				return;
			}
			syncRegisteredSlots(auth, ctx);
			if (
				family === "anthropic" ||
				family === "openai-codex" ||
				family === "kimi-coding" ||
				family === "cursor"
			) {
				const loginHint =
					family === "cursor"
						? `run /login, authenticate your Cursor subscription in the browser, select ${id}`
						: family === "anthropic"
							? `run /login, choose subscription (OAuth) or API key, select ${id}. Each login type uses its own slot; existing credentials are kept`
							: `run /login, choose "Use a subscription", select ${id}`;
				ctx.ui.notify(
					`pi-multi-account: ${loginHint}, then run /multi-account rediscover`,
					"info",
				);
			} else {
				ctx.ui.notify(
					`pi-multi-account: add an entry "${id}" to ~/.pi/agent/auth.json with {"type":"api_key","key":"<your key>"} and run /multi-account rediscover`,
					"info",
				);
			}
			return;
		}
		if (command === "remove" || command === "rm" || command === "delete") {
			const targetRaw = arg1?.trim();
			if (!targetRaw) {
				ctx.ui.notify(
					"pi-multi-account: usage: /multi-account remove <anthropic|codex|cursor|ollama|qwen|provider-id>",
					"warning",
				);
				return;
			}
			const auth = readAuthFile();
			const id = resolveRemoveTarget(targetRaw, auth, config.qwenProvider);
			if (!id) {
				const family = parseFamilyArg(targetRaw);
				ctx.ui.notify(
					family
						? `pi-multi-account: no ${family} account to remove.`
						: `pi-multi-account: unknown or missing account "${targetRaw}". Rotation: ${rotation.join(", ") || "none"}`,
					"warning",
				);
				return;
			}
			const removed = await removeAuthSlot(ctx, id);
			if (removed) {
				ctx.ui.notify(
					`pi-multi-account: removed ${id}. Rotation: ${rotation.join(" → ") || "none"}`,
					"info",
				);
			}
			return;
		}
		if (command === "revive") {
			const target = arg1?.trim();
			if (!target) {
				ctx.ui.notify(
					"pi-multi-account: usage: /multi-account revive <provider|all>",
					"warning",
				);
				return;
			}
			const targets =
				target === "all" ? [...invalidatedByProvider.keys()] : [target];
			let revived = 0;
			for (const p of targets) {
				if (invalidatedByProvider.delete(p)) revived++;
				exhaustedUntilByProvider.delete(p);
				authFailures.delete(p);
			}
			if (revived > 0) persist();
			refreshDiscovery(true, ctx);
			ctx.ui.notify(
				`pi-multi-account: revived ${revived} account(s)${target === "all" ? "" : ` (${target})`}. They are back in rotation.`,
				"info",
			);
			return;
		}
		if (command === "clear") {
			configuredFallbacks = [];
			config = { ...config, fallbacks: [] };
			try {
				mutateConfigFile(CONFIG_PATH, () => ({ fallbacks: [] }));
			} catch (error) {
				warnConfigNotSaved(ctx, error);
			}
			const removedSlots = [
				...new Set([
					...Object.keys(readAuthFileRaw()),
					...Object.keys(readProxyOAuthSidecar()),
				]),
			].filter((id) => /-account-\d+$/.test(id));
			let failedSlotRemovals = 0;
			for (const id of removedSlots) {
				if (!(await removeAuthSlot(ctx, id, false, false))) failedSlotRemovals++;
			}
			if (failedSlotRemovals > 0) {
				ctx.ui.notify(
					`pi-multi-account: could not safely remove ${failedSlotRemovals} alias credential(s); auth.json entries were left intact.`,
					"error",
				);
			}
			registeredSlots.clear();
			exhaustedUntilByProvider.clear();
			exhaustedUntilByModel.clear();
			invalidatedByProvider.clear();
			authFailures.clear();
			usageByProvider.clear();
			usageErrors.clear();
			codexModelCatalogByProvider.clear();
			discoveredCodexModelOrder = [];
			responseCooldownHints.clear();
			handledAssistantErrors.clear();
			currentPromptSwitch = undefined;
			chainEpoch++;
			autoContinuesThisPrompt = 0;
			resetGovernor();
			startFreshFailoverChain();
			userAbortedChain = false;
			clearPendingContinuation();
			clearQueuedInputs();
			persistedState = {
				stateVersion: STATE_VERSION,
				exhaustedUntilByProvider: {},
				exhaustedUntilByModel: {},
				lastProbeAtByProvider: {},
				invalidatedByProvider: {},
				usageByProvider: {},
				codexModelCatalogByProvider: {},
				lastSwitches: [],
			};
			saveState(persistedState);
			rotation = [];
			duplicateSlots = [];
			reloadHostAuth(ctx);
			ctx.ui.notify(
				`pi-multi-account: cleared all fallbacks, state and ${removedSlots.length} alias slot(s)${removedSlots.length ? ` (${removedSlots.join(", ")})` : ""}. Run /multi-account add <family> then /login to rebuild.`,
				"info",
			);
			return;
		}
		if (command === "reset") {
			chainEpoch++;
			exhaustedUntilByProvider.clear();
			currentPromptSwitch = undefined;
			autoContinuesThisPrompt = 0;
			resetGovernor();
			startFreshFailoverChain();
			userAbortedChain = false;
			recoveryFailures = 0;
			breakerOpenUntil = 0;
			watchdogAborting = false;
			expectingInjectedContinuation = false;
			authFailures.clear();
			responseCooldownHints.clear();
			handledAssistantErrors.clear();
			usageByProvider.clear();
			usageErrors.clear();
			clearPendingContinuation();
			clearQueuedInputs();
			exhaustedUntilByModel.clear();
			persistedState = {
				stateVersion: STATE_VERSION,
				exhaustedUntilByProvider: {},
				exhaustedUntilByModel: {},
				lastProbeAtByProvider: {},
				invalidatedByProvider: {},
				usageByProvider: {},
				codexModelCatalogByProvider: Object.fromEntries(
					codexModelCatalogByProvider.entries(),
				),
				lastSwitches: [],
			};
			invalidatedByProvider.clear();
			saveState(persistedState);
			refreshDiscovery(true, ctx);
			ctx.ui.notify(
				"pi-multi-account: cooldowns, invalidations and pending resume reset",
				"info",
			);
			return;
		}
		if (command === "accounts" || command === "account") {
			if (arg1 && arg1 !== "refresh") {
				ctx.ui.notify(
					"pi-multi-account: usage: /multi-account accounts [refresh]",
					"warning",
				);
				return;
			}
			if (arg1 === "refresh") {
				refreshDiscovery(false, ctx);
				const auth = readAuthFile();
				const duplicates = new Set(
					duplicateSlots.map(({ duplicate }) => duplicate),
				);
				const providers = Object.entries(auth)
					.filter(
						([provider, entry]) =>
							!!usageFamily(provider) &&
							isEntryUsable(entry) &&
							!duplicates.has(provider),
					)
					.map(([provider]) => provider);
				await Promise.all([
					...providers.map((provider) => refreshUsage(ctx, provider, true, true)),
					refreshAgyQuota(true),
				]);
			}
			ctx.ui.notify(renderAccountTable(ctx), "info");
			return;
		}
		if (command === "limits" || command === "usage" || command === "quota") {
			const provider = ctx.model?.provider;
			if (!provider || !usageFamily(provider)) {
				ctx.ui.notify(
					`pi-multi-account: usage limits are not available for ${provider ?? "the current model"}`,
					"warning",
				);
				return;
			}
			const snapshot = await refreshUsage(ctx, provider, arg1 === "refresh", true);
			const warning = usageErrors.get(provider);
			if (!snapshot) {
				ctx.ui.notify(
					`pi-multi-account: could not load limits for ${provider}${warning ? `: ${warning}` : ""}`,
					"warning",
				);
				return;
			}
			ctx.ui.notify(
				`${formatUsageDetails(displayUsageSnapshot(snapshot))}${warning ? `\nRefresh warning: ${warning}` : ""}`,
				warning ? "warning" : "info",
			);
			return;
		}
		if (command === "switch" || command === "use") {
			const target = arg1?.trim();
			if (!target) {
				ctx.ui.notify(
					`pi-multi-account: usage: /multi-account switch <provider>. Available: ${rotation.join(", ") || "none"}`,
					"warning",
				);
				return;
			}
			const parsed = resolveSwitchTarget(target, ctx);
			if (!parsed) {
				ctx.ui.notify(
					`pi-multi-account: unknown provider "${target}". Rotation: ${rotation.join(", ") || "none"}`,
					"warning",
				);
				return;
			}
			if ("ambiguous" in parsed) {
				ctx.ui.notify(
					`pi-multi-account: "${target}" matches ${parsed.ambiguous.join(", ")} — name one of them.`,
					"warning",
				);
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify(
					"pi-multi-account: no active model to switch from",
					"warning",
				);
				return;
			}
			claimUserControl(`manual switch ${target}`, true);
			const wasInvalid = invalidatedByProvider.delete(parsed.provider);
			authFailures.delete(parsed.provider);
			exhaustedUntilByProvider.delete(parsed.provider);
			for (const key of [...exhaustedUntilByModel.keys()]) {
				if (key.startsWith(`${parsed.provider}/`)) {
					exhaustedUntilByModel.delete(key);
				}
			}
			persist();
			refreshDiscovery(true, ctx);
			const resolvedTarget = parsed.modelId
				? `${parsed.provider}/${parsed.modelId}`
				: parsed.provider;
			const candidates = resolveTargets(ctx, resolvedTarget, ctx.model, true).filter(
				(model: any) => providerHasUsableAuth(ctx, model.provider) &&
					(parsed.modelId !== undefined || pinQualityCompatible(model, ctx.model)),
			);
			if (candidates.length === 0) {
				const hasAuth = providerHasUsableAuth(ctx, parsed.provider);
				ctx.ui.notify(
					hasAuth
						? `pi-multi-account: "${target}" is logged in but the host exposes no model for it yet. Run /multi-account rediscover, or restart Pi if you just logged in.`
						: `pi-multi-account: no credentials for "${target}" in auth.json — run /login and pick it. Rotation: ${rotation.join(", ") || "none"}`,
					"warning",
				);
				return;
			}
			if (wasInvalid)
				ctx.ui.notify(
					`pi-multi-account: cleared a stale invalidation on "${parsed.provider}" and is retrying it now.`,
					"info",
				);
			currentPromptSwitch = undefined;
			const switched = await activateFallback(
				ctx,
				ctx.model,
				candidates,
				`manual /multi-account switch ${target}`,
				{ armContinuation: false, manual: true },
			);
			currentPromptSwitch = undefined;
			if (switched) {
				announceManualChoice(ctx);
				await resumeQueuedInputsAfterManualSwitch(ctx, true);
			} else {
				ctx.ui.notify(
					`pi-multi-account: could not switch to "${target}"`,
					"warning",
				);
			}
			return;
		}
		function resolveSwitchTarget(
			target: string,
			ctx: any,
		):
			| { provider: string; modelId?: string }
			| { ambiguous: string[] }
			| undefined {
			const parsed = parseTarget(target);
			if (!parsed) return undefined;
			const known = new Set([...rotation, ...Object.keys(readAuthFile())]);
			if (known.has(parsed.provider)) return parsed;
			if (providerHasUsableAuth(ctx, parsed.provider)) return parsed;
			const needle = parsed.provider.toLowerCase();
			const matches = [...known].filter(
				(id) =>
					id.toLowerCase().startsWith(needle) || id.toLowerCase().includes(needle),
			);
			if (matches.length === 1) return { ...parsed, provider: matches[0] };
			if (matches.length > 1) return { ambiguous: matches.sort() };
			return parsed;
		}

		if (command === "best" || command === "live") {
			if (!ctx.model) {
				ctx.ui.notify(
					"pi-multi-account: no active model to switch from",
					"warning",
				);
				return;
			}
			claimUserControl("manual best", true);
			const candidates = findFallbackModels(ctx, ctx.model, {
				availableNowOnly: true,
				includeCurrent: true,
				preferSameIdentity: false,
				preserveQualityBand: true,
			});
			if (candidates.length === 0) {
				const wait = nextRecoveryStatus(ctx);
				ctx.ui.notify(
					`pi-multi-account: no account can serve work right now. ${wait}`,
					"warning",
				);
				return;
			}
			if (
				candidates[0].provider === ctx.model.provider &&
				candidates[0].id === ctx.model.id
			) {
				modelPreferenceChanged = true;
				rememberUserModel(ctx.model);
				ctx.ui.notify(
					`pi-multi-account: already on the best available account (${ctx.model.provider}/${ctx.model.id})`,
					"info",
				);
				await resumeQueuedInputsAfterManualSwitch(ctx, true);
				return;
			}
			currentPromptSwitch = undefined;
			const verified = isConfirmedAvailable(candidates[0].provider);
			const switched = await activateFallback(
				ctx,
				ctx.model,
				candidates,
				"manual /multi-account best",
				{ armContinuation: false, manual: true },
			);
			currentPromptSwitch = undefined;
			if (switched) {
				announceManualChoice(ctx);
				await resumeQueuedInputsAfterManualSwitch(ctx, true);
				if (!verified)
					ctx.ui.notify(
						`pi-multi-account: no account confirmed availability — ${ctx.model?.provider} has no quota endpoint to check, so this is an unverified guess. Everything measurable is spent.`,
						"warning",
					);
			}
			else
				ctx.ui.notify(
					"pi-multi-account: could not switch to the best available account",
					"warning",
				);
			return;
		}
		if (command === "only-active" || command === "focus") {
			const next2 =
				arg1 === "on" ? true : arg1 === "off" ? false : !onlyActiveModels;
			onlyActiveModels = next2;
			config = { ...config, onlyActive: next2 };
			try {
				mutateConfigFile(CONFIG_PATH, () => ({ onlyActive: next2 }));
			} catch (error) {
				warnConfigNotSaved(ctx, error);
			}
			if (next2) applyOnlyActiveFilter(ctx);
			else clearOnlyActiveFilter();
			ctx.ui.notify(
				next2
					? "pi-multi-account: only-active ON preference saved; use /multi-account pick for current-account models. The built-in /model and shared registry remain complete"
					: "pi-multi-account: only-active OFF — every provider's models restored",
				"info",
			);
			return;
		}
		if (command === "priority" || command === "order") {
			const rest = args.trim().split(/\s+/).slice(1).join(" ").trim();
			const groupsPresent = [
				...new Set(rotation.map((id) => normalizeGroup(id))),
			].filter(Boolean);

			if (!rest) {
				const lines = describePriority(config.providerPriority, groupsPresent);
				ctx.ui.notify(
					[
						"pi-multi-account: failover priority — where work goes once EVERY account of the",
						"current provider is spent. Same-provider failover always runs first, and an account",
						"on cooldown is never chosen over a free one; this only orders the rest.",
						"",
						...lines,
						"",
						"Set:   /multi-account priority anthropic openai-codex kimi-coding cursor",
						"Reset: /multi-account priority reset",
					].join("\n"),
					"info",
				);
				return;
			}

			const reset = /^(reset|default|defaults)$/i.test(rest);
			const cleared = /^(none|off|clear)$/i.test(rest);
			const next = reset
				? [...DEFAULT_PROVIDER_PRIORITY]
				: cleared
					? []
					: normalizePriority(rest);
			if (!reset && !cleared && next.length === 0) {
				ctx.ui.notify(
					`pi-multi-account: could not read any provider name in "${rest}". Try: /multi-account priority anthropic openai-codex kimi-coding cursor`,
					"warning",
				);
				return;
			}

			config = { ...config, providerPriority: next };
			try {
				mutateConfigFile(CONFIG_PATH, () => ({ providerPriority: next }));
			} catch (error) {
				warnConfigNotSaved(ctx, error);
			}
			logEvent("priority_set", { priority: next, reset, cleared });

			const unknown = next.filter((group) => !groupsPresent.includes(group));
			ctx.ui.notify(
				[
					cleared
						? "pi-multi-account: failover priority cleared — order decided by live availability alone."
						: reset
							? "pi-multi-account: failover priority reset to the default ladder."
							: "pi-multi-account: failover priority set.",
					...describePriority(next, groupsPresent),
					...(unknown.length > 0
						? [
								"",
								`Not logged in (kept in the ladder for when you are): ${unknown.join(", ")}`,
							]
						: []),
				].join("\n"),
				"info",
			);
			return;
		}
		if (command === "next") {
			if (ctx.model) {
				claimUserControl("manual next", true);
				const switched = await switchToFallback(
					ctx,
					ctx.model,
					"manual /multi-account next",
					0,
					{ manual: true },
				);
				currentPromptSwitch = undefined;
				if (switched) {
					announceManualChoice(ctx);
					await resumeQueuedInputsAfterManualSwitch(ctx, true);
				}
			}
			return;
		}
		if (command === "stop") {
			chainEpoch++;
			userAbortedChain = true;
			resetGovernor();
			startFreshFailoverChain();
			currentPromptSwitch = undefined;
			watchdogAborting = false;
			expectingInjectedContinuation = false;
			clearPendingContinuation();
			const heldNote = takeHeldMessagesNote();
			clearQueuedInputs();
			endResumeWatch();
			ctx.abort();
			ctx.ui.notify(
				`pi-multi-account: automatic failover/resume stopped for the current task.${heldNote}`,
				"info",
			);
			return;
		}
		if (command === "enable" || command === "disable") {
			config = { ...config, enabled: command === "enable" };
			if (!config.enabled) clearPendingContinuation();
			ctx.ui.notify(
				`pi-multi-account: failover ${config.enabled ? "enabled" : "disabled"} for this Pi process`,
				"info",
			);
			return;
		}

		refreshDiscovery(false, ctx);
		const authForStatus = readAuthFile();
		const authTag = (id: string) => {
			const kind = authTypeByProvider.get(id) ?? authTypeOfEntry(authForStatus[id]);
			return kind ? ` [${kind}]` : "";
		};
		const current = ctx.model
			? `${ctx.model.provider}/${ctx.model.id}${authTag(ctx.model.provider)}`
			: "none";
		const childView = slotsAsAChildSeesThem(rotation, readAuthFileRaw());
		const childUnusable = childView.filter((verdict) => !verdict.usable);
		const childRouteWarning = defaultRouteWarning(
			readHostDefaultModel()?.provider,
			(slotId) => slotsAsAChildSeesThem([slotId], readAuthFileRaw())[0],
		);
		const currentUsage = ctx.model
			? cachedUsage(ctx.model.provider)
			: undefined;
		const cooldowns = [...exhaustedUntilByProvider.entries()]
			.filter(([p, until]) => until > Date.now() && !isInvalidated(p))
			.map(([p, until]) => `${p}: ${formatUntil(until)}`);
		const invalids = [...invalidatedByProvider.entries()].map(
			([p, r]) => `${p} (${r.reason.slice(0, 40)})`,
		);
		ctx.ui.notify(
			[
				`pi-multi-account v${VERSION}: ${config.enabled ? "enabled" : "disabled"}${config.autoDiscover ? " · auto-discover ON" : " · auto-discover OFF"}`,
				`Code: ${LOADED_SOURCE_FINGERPRINT}${sourceFingerprint() !== LOADED_SOURCE_FINGERPRINT ? " — source changed; restart Pi after active work finishes to adopt it" : ""}`,
				`Current: ${current}`,
				`Current limits: ${
					currentUsage
						? formatUsageCompact(displayUsageSnapshot(currentUsage))
						: ctx.model && usageFamily(ctx.model.provider) === "qwen"
							? `${providerUsageLabel(ctx.model.provider)} | ${qwenLiveStatus(ctx.model.provider)}`
							: "not loaded"
				}`,
				`Rotation (${rotation.length}): ${rotation.map((provider) => `${provider}${authTag(provider)}`).join(" → ") || "none — log in to an account"}`,
				`Metered native providers (pay per token): ${meteredNativeMembers().join(", ") || "none"}`,
				`Other providers (no quota tracking): ${resellerRotationMembers().join(", ") || (config.includeOtherProviders ? "none" : "disabled by includeOtherProviders")}`,
				`Needs models configured (in rotation but unusable): ${unconfiguredRotationMembers(ctx).join(", ") || "none"}`,
				`Duplicate slots skipped: ${duplicateSlots.length ? duplicateSlots.map(({ duplicate, primary }) => `${duplicate} = ${primary}`).join(", ") : "none"}`,
				`Registered login slots: ${[...registeredSlots].join(", ") || "(base accounts only)"}`,
				`Cooldowns: ${cooldowns.length ? cooldowns.join(", ") : "none"}`,
				`Next recovery: ${nextRecoveryStatus(ctx)}`,
				`Invalidated (need re-login): ${invalids.length ? invalids.join(", ") : "none"}`,
				`Continuation: immediate ${config.autoContinue ? "ON" : "OFF"} · after all-account quota recovery ${config.resumeAfterAllAccountsRecover ? "ON" : "OFF"}`,
				`Pending auto-resume: ${hasPendingResume() ? `yes (${pendingResume?.mode ?? "unknown"}; reason: ${pendingResume?.reason ?? "unknown"})` : "none"}`,
				`Queued user messages: ${queuedUserInputs.length}`,
				`Resume watchdog: ${activeResumeWatch ? `watching${toolInFlight ? " · tool running" : ""}` : "idle"} · auto-recover ${config.autoRecoverStuck ? "ON" : "OFF"}`,
				`Compaction routing: ${config.routeCompactionToHealthyAccount ? "to healthy account" : "off"}${compactionRoutedNote ? ` (last: ${compactionRoutedNote})` : ""}${lastContextOverflowAt ? ` · last overflow ${formatUntil(lastContextOverflowAt)}` : ""}`,
				`Auto-continue breaker: ${isBreakerOpen() ? `OPEN — advisory mode until ${formatUntil(breakerOpenUntil)} (manual switching; /multi-account reset to re-enable)` : `closed${recoveryFailures ? ` (${recoveryFailures}/${BREAKER_FAILURE_THRESHOLD} recent failures)` : ""}`}`,
				`Governor: ${
					governorStopped()
						? `STOPPED — ${governorStoppedReason}. Send a message or run /multi-account reset to re-enable.`
						: `running · ${actionsSinceRequest}/${GOVERNOR_ACTIONS_WITHOUT_REQUEST} steps since a request reached a provider · ${actionsSinceSuccess}/${GOVERNOR_ACTIONS_WITHOUT_SUCCESS} since one answered`
				}`,
				`Debug log: ${config.debugLog ? `on → ${DEBUG_LOG_PATH} (/multi-account log to view)` : "off"}`,
				`Extension-free children: ${childView.length - childUnusable.length}/${childView.length} rotation slots usable${
					childUnusable.length
						? ` · cannot authenticate: ${childUnusable.map((verdict) => verdict.slotId).join(", ")}`
						: ""
				}${childRouteWarning ? `\n  ⚠️ ${childRouteWarning}` : ""}`,
				`Config: ${CONFIG_PATH}`,
				// external: Pi publishes these configuration files without versioned schemas.
				`Pi file contract: ${
					lastContractVerdicts.length === 0
						? "not checked yet"
						: lastContractVerdicts.every((verdict) => verdict.ok)
							? `${lastContractVerdicts.map((verdict) => verdict.file).join(", ")} as expected`
							: lastContractVerdicts
									.filter((verdict) => !verdict.ok)
									.map((verdict) => `${verdict.file}: ${verdict.problems.join("; ")}`)
									.join(" | ")
				}`,
				`Failover priority (after every account of the current provider is spent): ${
					config.providerPriority.length > 0
						? `${config.providerPriority.join(" → ")} → everything else`
						: "none set — decided by live availability alone"
				} · /multi-account priority to change`,
				`Switch accounts: /multi-account best — jump straight to an account that can work now · /multi-account switch <provider> — e.g. /multi-account switch ${rotation.find((p) => p !== ctx.model?.provider) ?? rotation[0] ?? "<provider>"} · /multi-account next steps through the rotation in order`,
				`Model pins: ${Object.entries(config.pinnedModels).map(([scope, id]) => `${scope}/${id}`).join(", ") || "none"} · /multi-account pins to inspect`,
				`Other commands: status | accounts [refresh] | best | priority [...] | limits [refresh] | models | pick | pin <provider/model> | unpin <provider-or-family> | pins [list] | save-default | log [N|on|off] | only-active [on|off] | rediscover | add [anthropic|codex|kimi|cursor|ollama|qwen] | remove [anthropic|codex|kimi|cursor|ollama|qwen|<provider-id>] | revive <provider|all> | clear | stop | reset | reload | enable | disable`,
			].join("\n"),
			"info",
		);
	}

	const safeHandleCommand = async (args: string, ctx: any) => {
		try {
			return await handleCommand(args, ctx);
		} catch (error) {
			reportExtensionError(
				`/multi-account ${args.trim().split(/\s+/)[0] || "status"}`,
				error,
				ctx,
			);
			return undefined;
		}
	};
	for (const name of ["multi-account", "provider-failover", "failover"]) {
		pi.registerCommand(name, {
			description: "Manage automatic multi-account failover & rotation",
			handler: safeHandleCommand,
			getArgumentCompletions: (prefix: string) => {
				try {
					return multiAccountCompletions(prefix, accountChoices);
				} catch (error) {
					logEvent("command_completion_failed", { error: String(error).slice(0, 200) });
					return null;
				}
			},
		});
	}

	registerAnthropicLoginMethods(pi, ANTHROPIC_BASE);
	pi.registerProvider("openai-codex", {
		oauth: codexOAuthOverride(
			"openai-codex",
			"ChatGPT Plus/Pro (Codex Subscription)",
		),
	} as any);

	const ensureApiKeyBaseProvider = (
		family: "ollama" | "qwen",
		baseId: string,
	) => {
		const entry = readAuthFile()[baseId];
		const key =
			entry && typeof entry.key === "string" && entry.key.length > 0
				? entry.key
				: undefined;
		if (!key) return;
		const baseUrl = family === "ollama" ? OLLAMA_CLOUD_BASE_URL : QWEN_BASE_URL;
		const preferred =
			family === "ollama" ? DEFAULT_OLLAMA_MODELS : DEFAULT_QWEN_MODELS;
		const ids = [...preferred];
		if (family === "ollama") {
			for (const discovered of discoveredOllamaModelIds) {
				if (!ids.includes(discovered)) ids.push(discovered);
			}
		}
		for (const configured of configuredModelIds(baseId)) {
			if (!ids.includes(configured)) ids.push(configured);
		}
		const models = ids.map((m) =>
			family === "ollama" ? ollamaModelDef(m, baseId) : qwenModelDef(m, baseId),
		);
		models.push(...configuredOperationModels(baseId));
		pi.registerProvider(baseId, {
			name: family === "ollama" ? "Ollama" : "Alibaba/Qwen",
			baseUrl,
			api: "openai-completions" as any,
			...(family === "qwen" ? { streamSimple: qwenPayloadStream } : {}),
			apiKey: key,
			models: models as any,
		} as any);
	};
	ensureApiKeyBaseProvider("ollama", OLLAMA_BASE);
	ensureApiKeyBaseProvider("qwen", config.qwenProvider);

	safeOn("context", (event: any) => {
		if (!automaticFailoverEnabled() || !config.preserveInterruptedContext) return undefined;
		const messages = event?.messages;
		if (!Array.isArray(messages) || messages.length === 0) return undefined;
		const preserved = preserveInterruptedTurns(messages);
		if (preserved === messages) return undefined;
		const rescued = messages.length - preserved.length;
		logEvent("interrupted_context_preserved", {
			messages: messages.length,
			folded: rescued,
		});
		return { messages: preserved };
	});

	const contextGuardTrackers = new Map<string, OverheadTracker>();
	const contextGuardElided = new Set<string>();
	let contextGuardLastRaw = 0;
	let contextGuardTrimmedLastRequest = false;
	let contextGuardWantsCompaction = false;
	let contextGuardCompactionInFlight = false;
	let contextGuardCompactionRetryAfter = 0;
	let contextGuardLastCompactionAt = 0;
	// external: ctx.compact() initiates compaction without waiting for its completion.
	let contextGuardContinuationPending = false;
	let contextGuardNotifiedThisRun = false;
	let contextGuardHookSeen = false;
	let contextGuardWindowSeen = false;
	let contextGuardLlmCalls = 0;
	const contextGuardWarned = new Set<string>();

	const CONTEXT_GUARD_HEALTH_AFTER_CALLS = 5;

	function contextGuardWarn(ctx: any, kind: string, message: string) {
		if (contextGuardWarned.has(kind)) return;
		contextGuardWarned.add(kind);
		logEvent("context_guard_inert", { kind, message });
		try {
			ctx?.ui?.notify?.(`pi-multi-account: ${message}`, "warning");
		} catch {
		}
	}

	const CONTEXT_GUARD_COMPACTION_COOLDOWN_MS = 120_000;
	const CONTEXT_GUARD_COMPACTION_FAILURE_BACKOFF_MS = 120_000;
	const contextGuardCompactionWaitMs = () =>
		config.compactionWatchdogMs + Math.min(30_000, config.compactionWatchdogMs);

	function contextGuardTracker(ctx: any): OverheadTracker {
		const key = `${ctx?.model?.provider ?? "?"}/${ctx?.model?.id ?? "?"}`;
		let tracker = contextGuardTrackers.get(key);
		if (!tracker) {
			tracker = createOverheadTracker();
			contextGuardTrackers.set(key, tracker);
		}
		return tracker;
	}

	function contextGuardActive(): boolean {
		return automaticFailoverEnabled() && config.contextGuard.enabled && !recoveryArbiter.policyRefusalStopped;
	}

	// external: Pi 0.87 and later can expose context_with_system.
	const contextGuardPhase = piHasContextWithSystem(PI_HOST_VERSION) ? "context_with_system" : "context";
	safeOn(contextGuardPhase, (event: any, ctx: any) => {
		if (!contextGuardActive()) return undefined;
		contextGuardHookSeen = true;
		if (typeof ctx?.compact !== "function")
			contextGuardWarn(
				ctx,
				"compact_missing",
				"this Pi build no longer exposes compaction to extensions, so the context guard can trim " +
					"requests but can never ask for a summary. Check for an extension update.",
			);
		const settings = config.contextGuard;
		const messages = event?.messages;
		if (!Array.isArray(messages) || messages.length === 0) return undefined;

		let systemPrompt = "";
		if (contextGuardPhase === "context_with_system") {
			systemPrompt = messages
				.filter((message: any) => message?.role === "system")
				.map((message: any) =>
					typeof message.content === "string"
						? message.content
						: Array.isArray(message.content)
							? message.content.map((block: any) => (typeof block?.text === "string" ? block.text : "")).join("")
							: "",
				)
				.join("\n");
		} else {
			try {
				systemPrompt = ctx?.getSystemPrompt?.() ?? "";
			} catch {
				systemPrompt = "";
			}
		}
		const raw = estimateRawTokens(messages as GuardMessage[], systemPrompt);
		const tracker = contextGuardTracker(ctx);
		const decision = decideGuard(
			tracker.adjust(raw),
			Number(ctx?.model?.contextWindow ?? 0),
			settings,
		);
		contextGuardLastRaw = raw;
		contextGuardTrimmedLastRequest = false;
		if (decision.window <= 0) return undefined;
		contextGuardWindowSeen = true;
		if (decision.wantCompaction) {
			if (Date.now() >= contextGuardCompactionRetryAfter)
				contextGuardWantsCompaction = true;
		} else {
			contextGuardWantsCompaction = false;
		}
		if (!decision.trim && contextGuardElided.size === 0) return undefined;

		const existing = planElision(messages as GuardMessage[], contextGuardElided, {
			targetTokens: Number.POSITIVE_INFINITY,
			keepVerbatimTokens: settings.keepVerbatimTokens,
			minElideTokens: settings.minElideTokens,
		});
		const outgoing = decideGuard(
			tracker.adjust(estimateRawTokens(existing.messages, systemPrompt)),
			Number(ctx?.model?.contextWindow ?? 0),
			settings,
		);
		const plan = outgoing.trim ? planElision(messages as GuardMessage[], contextGuardElided, {
			targetTokens: Math.max(0, outgoing.targetTokens - tracker.overhead() - estimateRawTokens([], systemPrompt)),
			keepVerbatimTokens: settings.keepVerbatimTokens,
			minElideTokens: settings.minElideTokens,
		}) : existing;
		if (!plan.changed) return undefined;
		contextGuardTrimmedLastRequest = true;
		if (plan.elidedNow > 0) {
			logEvent("context_guard_trimmed", {
				model: `${ctx?.model?.provider}/${ctx?.model?.id}`,
				window: decision.window,
				percentBefore: Math.round(decision.percent * 100),
				rawTokens: raw,
				overhead: tracker.overhead(),
				elidedNow: plan.elidedNow,
				elidedTotal: plan.elidedTotal,
				freedTokens: plan.freedTokens,
				tokensAfter: plan.tokensAfter,
			});
			if (!contextGuardNotifiedThisRun) {
				contextGuardNotifiedThisRun = true;
				try {
					ctx?.ui?.notify?.(
						`pi-multi-account: context reached ${Math.round(decision.percent * 100)}% of the ` +
							`${decision.window.toLocaleString("en-US")}-token guard limit mid-run` +
							(Number(ctx?.model?.contextWindow) > decision.window
								? ` (model window ${Number(ctx.model.contextWindow).toLocaleString("en-US")})`
								: "") +
							`; older tool output is ` +
							`being left out of requests and a summary is queued. Nothing was removed from the transcript.`,
						"info",
					);
				} catch {
				}
			}
		}
		return { messages: plan.messages };
	});

	safeOn("message_end", (event: any, ctx: any) => {
		if (!contextGuardActive()) return undefined;
		const usage = event?.message?.usage;
		if (usage) contextGuardLlmCalls++;
		if (contextGuardLlmCalls >= CONTEXT_GUARD_HEALTH_AFTER_CALLS) {
			if (!contextGuardHookSeen) {
				contextGuardWarn(
					ctx,
					"hook_missing",
					"the context guard is NOT running: this Pi build no longer calls the pre-request hook it " +
						"needs, so long autonomous runs are unprotected against context overflow again. Check for " +
						"an extension update.",
				);
			} else if (!contextGuardWindowSeen) {
				contextGuardWarn(
					ctx,
					"window_unknown",
					`the context guard is standing down on ${ctx?.model?.provider}/${ctx?.model?.id}: Pi does not ` +
						"know this model's context window, so there is nothing to measure against. Give the model a " +
						"contextWindow in models.json to switch the guard back on.",
				);
			}
		}
		if (contextGuardTrimmedLastRequest) return undefined;
		if (!usage || contextGuardLastRaw <= 0) return undefined;
		const reported =
			Number(usage.input ?? 0) + Number(usage.cacheRead ?? 0) + Number(usage.cacheWrite ?? 0);
		if (!(reported > 0)) return undefined;
		contextGuardTracker(ctx).observe(contextGuardLastRaw, reported);
		return undefined;
	});

	safeOn("agent_start", () => {
		contextGuardNotifiedThisRun = false;
		return undefined;
	});

	let contextGuardCompactionTimer: ReturnType<typeof setTimeout> | undefined;
	let contextGuardRequestSeq = 0;

	function clearContextGuardCompactionWait() {
		contextGuardCompactionInFlight = false;
		if (contextGuardCompactionTimer) {
			clearTimeout(contextGuardCompactionTimer);
			contextGuardCompactionTimer = undefined;
		}
	}

	function releaseContextGuardRecovery(lease = contextGuardRecoveryLease) {
		if (!lease) return;
		if (contextGuardRecoveryLease === lease) {
			contextGuardRecoveryLease = undefined;
			contextGuardRecoveryEpoch = undefined;
		}
		lease.release();
	}

	function settleContextGuardCompaction() {
		clearContextGuardCompactionWait();
		releaseContextGuardRecovery();
	}

	function failContextGuardCompaction(
		kind: "context_guard_compaction_failed" | "context_guard_compaction_unanswered",
		error?: unknown,
		ctx?: any,
		lease = contextGuardRecoveryLease,
		epoch = contextGuardRecoveryEpoch,
	) {
		if (epoch !== undefined && epoch !== chainEpoch) {
			clearContextGuardCompactionWait();
			releaseContextGuardRecovery(lease);
			return;
		}
		if (isPolicyRefusal(error))
			stopAutomaticRecoveryForPolicyRefusal(ctx, ctx?.model?.provider, ctx?.model?.id);
		const resumeAfterFailure =
			contextGuardContinuationPending && !recoveryArbiter.policyRefusalStopped;
		const hadDemand = contextGuardWantsCompaction || contextGuardCompactionInFlight;
		contextGuardWantsCompaction = false;
		contextGuardContinuationPending = false;
		if (hadDemand) {
			contextGuardCompactionRetryAfter =
				Date.now() + CONTEXT_GUARD_COMPACTION_FAILURE_BACKOFF_MS;
			clearContextGuardCompactionWait();
			logEvent(kind, {
				...(error === undefined ? {} : { error: String(error) }),
				backoffMs: CONTEXT_GUARD_COMPACTION_FAILURE_BACKOFF_MS,
			});
		} else {
			clearContextGuardCompactionWait();
		}
		if (resumeAfterFailure && ctx && !userAbortedChain) {
			queueMicrotask(() => {
				if ((epoch !== undefined && epoch !== chainEpoch) || recoveryArbiter.policyRefusalStopped) {
					releaseContextGuardRecovery(lease);
					return;
				}
				contextGuardContinuationPending = true;
				dispatchContextGuardContinuation(ctx, lease, epoch);
			});
		} else {
			releaseContextGuardRecovery(lease);
		}
	}

	function armContextGuardCompactionWatchdog(ctx: any) {
		if (contextGuardCompactionTimer) clearTimeout(contextGuardCompactionTimer);
		const waitedMs = contextGuardCompactionWaitMs();
		contextGuardCompactionTimer = setTimeout(() => {
			contextGuardCompactionTimer = undefined;
			if (!contextGuardCompactionInFlight) return;
			failContextGuardCompaction(
				"context_guard_compaction_unanswered",
				undefined,
				ctx,
			);
		}, waitedMs);
		contextGuardCompactionTimer.unref?.();
	}

	safeOn("agent_settled", (_event: any, ctx: any) => {
		if (!contextGuardActive()) return undefined;
		if (!contextGuardWantsCompaction || contextGuardCompactionInFlight) return undefined;
		if (Date.now() < contextGuardCompactionRetryAfter) return undefined;
		if (Date.now() - contextGuardLastCompactionAt < CONTEXT_GUARD_COMPACTION_COOLDOWN_MS)
			return undefined;
		if (!ctx?.isIdle?.()) return undefined;
		if (ctx?.hasPendingMessages?.()) return undefined;
		if (hasPendingResume()) return undefined;
		const recoveryLease = recoveryArbiter.tryAcquire({
			category: "context_limit",
			provider: ctx?.model?.provider,
			model: ctx?.model?.id,
			sessionId: recoverySessionId(ctx),
		});
		if (!recoveryLease) return undefined;
		recoveryLease.markRecovering("context_limit", ctx?.model?.provider, ctx?.model?.id);
		if (!allowAction("ask for a summary", ctx)) {
			recoveryLease.release();
			return undefined;
		}
		contextGuardRecoveryLease = recoveryLease;
		const recoveryEpoch = chainEpoch;
		contextGuardRecoveryEpoch = recoveryEpoch;
		contextGuardCompactionInFlight = true;
		contextGuardContinuationPending = true;
		contextGuardLastCompactionAt = Date.now();
		const requestSeq = ++contextGuardRequestSeq;
		const supersededRequest = (callback: string) => {
			if (requestSeq === contextGuardRequestSeq) return false;
			logEvent("context_guard_stale_callback", { callback });
			return true;
		};
		logEvent("context_guard_compaction_requested", {
			model: `${ctx?.model?.provider}/${ctx?.model?.id}`,
			elided: contextGuardElided.size,
		});
		armContextGuardCompactionWatchdog(ctx);
		try {
			ctx.compact({
				onComplete: () => {
					if (supersededRequest("onComplete")) return;
					clearContextGuardCompactionWait();
					dispatchContextGuardContinuation(ctx, recoveryLease, recoveryEpoch);
				},
				onError: (error: Error) => {
					if (supersededRequest("onError")) return;
					failContextGuardCompaction(
						"context_guard_compaction_failed",
						String(error?.message ?? error),
						ctx,
						recoveryLease,
						recoveryEpoch,
					);
				},
			});
		} catch (error) {
			failContextGuardCompaction(
				"context_guard_compaction_failed",
				error,
				ctx,
				recoveryLease,
				recoveryEpoch,
			);
		}
		return undefined;
	});

	safeOn("session_compact", () => {
		contextGuardElided.clear();
		contextGuardWantsCompaction = false;
		contextGuardCompactionRetryAfter = 0;
		clearContextGuardCompactionWait();
		contextGuardLastRaw = 0;
		contextGuardTrimmedLastRequest = false;
		return undefined;
	});

	const CONTINUE_AFTER_COMPACTION_TYPE = "multi-account:continue-after-compaction";
	const CONTINUE_AFTER_COMPACTION_PROMPT = [
		"The conversation history above was just compacted automatically: it is now a summary plus",
		"the most recent messages. Nothing was cancelled and nothing was asked of you — carry on with",
		"the task you were already working on, from the point where it stopped.",
		"",
		"- Do not restart the task, and do not redo work the summary records as already done.",
		"- If you need a result the summary does not carry, re-read the file or re-run the command",
		"  rather than assuming what it said.",
		"- If the task really is finished, do not invent more work: say so in one line and stop.",
	].join("\n");

	async function dispatchContextGuardContinuation(
		ctx: any,
		parentLease?: AutomaticRecoveryLease,
		epoch = contextGuardRecoveryEpoch,
	) {
		if (epoch !== undefined && epoch !== chainEpoch) {
			releaseContextGuardRecovery(parentLease);
			return;
		}
		const recoveryLease = recoveryArbiter.tryAcquire(
			{
				category: "context_limit",
				provider: ctx?.model?.provider,
				model: ctx?.model?.id,
				sessionId: recoverySessionId(ctx),
			},
			parentLease,
		);
		if (!recoveryLease) {
			releaseContextGuardRecovery(parentLease);
			return;
		}
		let continuationQueued = false;
		try {
		if (!contextGuardContinuationPending) return;
		contextGuardContinuationPending = false;
		if (!config.enabled || !config.continueAfterCompaction) {
			logEvent("compaction_continue_skipped", {
				reason: "post-compaction continuation disabled",
				compactionReason: "context_guard",
			});
			return;
		}
		if (userAbortedChain || ctx?.signal?.aborted) {
			logEvent("compaction_continue_skipped", {
				reason: "user aborted while context-guard compaction was running",
			});
			return;
		}
		if (queuedUserInputs.length > 0) {
			logEvent("compaction_continue_skipped", {
				reason: "held user input will resume after compaction",
			});
			return;
		}
		if (ctx?.hasPendingMessages?.()) {
			logEvent("compaction_continue_skipped", {
				reason: "another message is already queued after context-guard compaction",
			});
			return;
		}
		if (ctx?.isIdle?.() === false) {
			logEvent("compaction_continue_skipped", {
				reason: "another turn already started after context-guard compaction",
			});
			return;
		}
		if (autoContinuesThisPrompt >= config.maxAutoContinuesPerPrompt) {
			logEvent("compaction_continue_skipped", {
				reason: "auto-continue budget spent",
				used: autoContinuesThisPrompt,
				budget: config.maxAutoContinuesPerPrompt,
			});
			return;
		}
		if (!allowAction("carry on after context-guard compaction", ctx)) return;
		recoveryLease.markRecovering("context_limit", ctx?.model?.provider, ctx?.model?.id);
		expectingInjectedContinuation = true;
		try {
			await pi.sendUserMessage(CONTINUE_AFTER_COMPACTION_PROMPT, {
				deliverAs: "followUp",
			});
			continuationQueued = true;
			continuationRecoveryLease = parentLease ?? recoveryLease;
			autoContinuesThisPrompt++;
			logEvent("compaction_continue", {
				compactionReason: "context_guard",
				model: `${ctx?.model?.provider}/${ctx?.model?.id}`,
				hop: autoContinuesThisPrompt,
				budget: config.maxAutoContinuesPerPrompt,
			});
		} catch (error) {
			expectingInjectedContinuation = false;
			logEvent("compaction_continue_failed", {
				error: String(error).slice(0, 200),
			});
			ctx.ui?.notify?.(
				"Multi Account could not resume after compaction. The continuation was rejected; inspect the transcript before continuing manually.",
				"warning",
			);
		}
		} finally {
			if (!continuationQueued) {
				if (parentLease) releaseContextGuardRecovery(parentLease);
				else recoveryLease.release();
			}
		}
	}

	safeOn("session_compact", (event: any, ctx: any) => {
		if (!automaticFailoverEnabled() || !config.continueAfterCompaction) return undefined;
		if (recoveryArbiter.policyRefusalStopped || contextGuardContinuationPending) return undefined;
		if (event?.reason !== "threshold" && event?.reason !== "overflow") return undefined;
		// external: Pi can retry a turn after automatic compaction.
		if (event?.willRetry) return undefined;
		if (ctx?.isIdle?.() !== false) return undefined;
		if (userAbortedChain || ctx?.signal?.aborted) return undefined;
		if (ctx?.hasPendingMessages?.()) return undefined;
		if (autoContinuesThisPrompt >= config.maxAutoContinuesPerPrompt) {
			logEvent("compaction_continue_skipped", {
				reason: "auto-continue budget spent",
				used: autoContinuesThisPrompt,
				budget: config.maxAutoContinuesPerPrompt,
			});
			return undefined;
		}

		const parentLease = contextGuardRecoveryLease ?? continuationRecoveryLease;
		const recoveryLease = recoveryArbiter.tryAcquire(
			{
				category: "context_limit",
				provider: ctx?.model?.provider,
				model: ctx?.model?.id,
				sessionId: recoverySessionId(ctx),
			},
			parentLease,
		);
		if (!recoveryLease) return undefined;
		let continuationQueued = false;
		try {
			if (!allowAction("carry on after compaction", ctx)) return undefined;
			recoveryLease.markRecovering("context_limit", ctx?.model?.provider, ctx?.model?.id);
			const wasExpectingInjectedContinuation = expectingInjectedContinuation;
			expectingInjectedContinuation = true;
			try {
				// external: Pi sendCustomMessage queues follow-up before its first await.
				pi.sendMessage(
					{
						customType: CONTINUE_AFTER_COMPACTION_TYPE,
						content: CONTINUE_AFTER_COMPACTION_PROMPT,
						display: true,
					} as any,
					{ deliverAs: "followUp" },
				);
				continuationQueued = true;
				continuationRecoveryLease = parentLease ?? recoveryLease;
				autoContinuesThisPrompt++;
				logEvent("compaction_continue", {
					compactionReason: event?.reason,
					model: `${ctx?.model?.provider}/${ctx?.model?.id}`,
					hop: autoContinuesThisPrompt,
					budget: config.maxAutoContinuesPerPrompt,
				});
			} catch (error) {
				expectingInjectedContinuation = wasExpectingInjectedContinuation;
				logEvent("compaction_continue_failed", {
					compactionReason: event?.reason,
					error: String(error).slice(0, 200),
				});
			}
		} finally {
			if (!continuationQueued) recoveryLease.release();
		}
		return undefined;
	});

	safeOn("before_provider_request", (event: any, ctx?: any) => {
		const request = event?.request as
			| { kind?: string; sessionId?: string; model?: RouteModelRef }
			| undefined;
		if (request?.kind !== "background") noteProviderRequestObserved();
		const shaped = shapeAnthropicOAuthPayload(event.payload);
		const payload = (shaped ?? event.payload) as
			| Record<string, unknown>
			| undefined;
		const provider = request?.model?.provider ?? ctx?.model?.provider;
		if (payload && typeof provider === "string") {
			if (isCursorProviderId(provider)) {
				payload.pi_session_id = request?.sessionId ?? ctx?.sessionManager?.getSessionId?.();
			}
			// external: Qwen rejects the OpenAI developer role.
			if (classifyProvider(provider, config.qwenProvider) === "qwen") {
				rewriteDeveloperRoleToSystem(payload);
			}
		}
		return shaped;
	});


	let slotProxyServer: Server | undefined;
	let slotProxyPort: number | undefined;
	let slotProxyStarting: Promise<number | undefined> | undefined;
	let completionRouterContext: any;
	let slotProxyForeignOwner = false;
	let slotProxyContext: any;
	const slotProxyRoutes = new Map<string, ProxyRoute>();
	const SLOT_PROXY_PORT =
		Number(process.env.PI_MULTI_ACCOUNT_SLOT_PROXY_PORT) || 41977;

	function ownsSharedChildPublication(): boolean {
		if (subagentChild) return false;
		if (!config.childProxy) {
			const cohort = slotProxyCoordinator ?? coordinators.get(SLOT_PROXY_PORT);
			if (cohort?.server || [...(cohort?.members.values() ?? [])].some((member) => member.proxyEnabled)) {
				return false;
			}
			return !Object.entries(readAuthFileRaw()).some(([id, entry]) =>
				isChildFacingPlaceholderForSlot(entry, id));
		}
		if (sessionClosed) return false;
		const coordinator = slotProxyCoordinator;
		return !!coordinator && coordinator.members.has(activationOwner) &&
			coordinator.publisher === activationOwner && coordinator.server?.listening === true &&
			!slotProxyForeignOwner && slotProxyPort === SLOT_PROXY_PORT;
	}

	async function publishNativeSlot(provider: string, entry: NativeProviderEntry): Promise<void> {
		if (sessionClosed) return;
		const pending = provisionNativeSlot(provider, entry, () => !sessionClosed && ownsSharedChildPublication());
		pendingNativePublications.add(pending);
		try { await pending; } finally { pendingNativePublications.delete(pending); }
	}

	function readyProxyOwner(coordinator: SharedProxyCoordinator): object | undefined {
		return [...coordinator.members].reverse().find(([, member]) => member.ready)?.[0];
	}

	function relinquishRoot(): void {
		if (supersededRoot) return;
		supersededRoot = true;
		subagentChild = true;
		sessionClosed = true;
		chainEpoch++;
		completionRouterContext = undefined;
		if (pendingWakeTimer) clearTimeout(pendingWakeTimer);
		pendingWakeTimer = undefined;
		clearUsageStatusTimer();
		endResumeWatch();
		clearQueuedInputs();
	}

	function prepareSharedRoutes(slotIds: readonly string[], port: number): boolean {
		if (config.childProxy || sessionClosed || subagentChild) return false;
		slotProxyPort = port;
		for (const id of slotIds) {
			if (!registeredSlots.has(id)) continue;
			const baseUrl = publishedRouteFor(port, id);
			const family = proxyFamilyOf(id);
			if (family === "codex") {
				const cached = codexModelCatalogByProvider.get(id)?.models;
				registerCodexSlot(pi, id, config.autoDiscoverModels && cached?.length
					? (cached as Array<Record<string, unknown>>) : undefined, baseUrl);
			} else if (family === "anthropic") {
				registerAnthropicSlot(pi, id, anthropicSlotModelIds(), baseUrl);
			}
		}
		return true;
	}

	function joinSharedProxy(sessionId?: string): void {
		let coordinator = coordinators.get(SLOT_PROXY_PORT);
		if (!coordinator) {
			coordinator = { members: new Map(), routes: new Map(), sessionOwners: new Map() };
			coordinators.set(SLOT_PROXY_PORT, coordinator);
		}
		if (coordinator.handoffTimer) {
			clearTimeout(coordinator.handoffTimer);
			coordinator.handoffTimer = undefined;
		}
		slotProxyCoordinator = coordinator;
		if (sessionId) {
			const previousOwner = coordinator.sessionOwners.get(sessionId);
			if (previousOwner && previousOwner !== activationOwner) {
				coordinator.members.get(previousOwner)?.relinquish();
				coordinator.members.delete(previousOwner);
				if (coordinator.publisher === previousOwner) coordinator.publisher = readyProxyOwner(coordinator);
				if (coordinator.handlerOwner === previousOwner) coordinator.handlerOwner = readyProxyOwner(coordinator);
			}
			coordinator.sessionOwners.set(sessionId, activationOwner);
		}
		coordinator.members.set(activationOwner, {
			sessionId, ready: false, proxyEnabled: config.childProxy,
			prepareRoutes: prepareSharedRoutes, relinquish: relinquishRoot,
			handleRequest: handleProxyRequest,
		});
	}

	function activateSharedProxy(): void {
		const coordinator = slotProxyCoordinator;
		const member = coordinator?.members.get(activationOwner);
		if (!member || sessionClosed || subagentChild || !coordinator?.server?.listening) return;
		member.ready = true;
		coordinator.handlerOwner = activationOwner;
		coordinator.handoffUntil = undefined;
	}

	refreshDiscovery(true);


	function proxyFamilyOf(slotId: string): ProxyFamily | undefined {
		return proxyFamilyFor(slotId);
	}

	function numberedAnthropicBaseUrl(id: string): string {
		const raw = readAuthFileRaw()[id];
		if (raw?.type === "api_key" && !isChildFacingPlaceholderForSlot(raw, id)) return "https://api.anthropic.com";
		if (typeof slotProxyPort === "number") return publishedRouteFor(slotProxyPort, id);
		if (isChildFacingPlaceholderForSlot(raw, id)) return publishedRouteFor(SLOT_PROXY_PORT, id);
		return "https://api.anthropic.com";
	}

	function numberedCodexBaseUrl(id: string): string {
		const raw = readAuthFileRaw()[id];
		if (raw?.type === "api_key" && !isChildFacingPlaceholderForSlot(raw, id)) return "https://chatgpt.com/backend-api";
		if (typeof slotProxyPort === "number") return publishedRouteFor(slotProxyPort, id);
		if (!config.childProxy && !isChildFacingPlaceholderForSlot(readAuthFileRaw()[id], id)) {
			return "https://chatgpt.com/backend-api";
		}
		return publishedRouteFor(SLOT_PROXY_PORT, id);
	}

	function restoreChildFacingAuth(): void {
		try { mutateProxyAuth(AUTH_PATH, PROXY_OAUTH_PATH, applyRestoreAll, "restore"); }
		catch { logEvent("auth_publication_deferred", { operation: "restore" }); }
	}

	function shadowChildFacingAuth(slotIds: readonly string[]): void {
		try { mutateProxyAuth(AUTH_PATH, PROXY_OAUTH_PATH,
			(auth, sidecar) => applyShadowAll(slotIds, auth, sidecar), "shadow"); }
		catch { logEvent("auth_publication_deferred", { operation: "shadow" }); }
	}

	async function credentialForProxy(slotId: string): Promise<AuthEntry | undefined> {
		let entry = readAuthFile()[slotId];
		if (!entry) return undefined;
		if (entry.type !== "oauth" || typeof entry.access !== "string") return entry;
		const expiry = oauthExpiryMs(entry);
		if (expiry !== undefined && expiry - 60_000 <= Date.now()) {
			clearReauthedInvalidations(readAuthFile());
			if (isInvalidated(slotId)) return entry;
			try {
				const refresh = await forceRefreshProvider(slotProxyContext, slotId);
				if (refresh.status === "refreshed") {
					entry = readAuthFile()[slotId] ?? entry;
				} else if (refresh.status === "terminal") {
					const reason = `OAuth refresh failed permanently: ${refresh.error}`;
					logEvent("slot_proxy_refresh_failed", {
						slot: slotId,
						status: refresh.status,
						reason: refresh.error,
					});
					markInvalid(slotId, reason);
				} else {
					logEvent("slot_proxy_refresh_failed", {
						slot: slotId,
						status: refresh.status,
						reason: refresh.status === "transient" ? refresh.error : "unsupported",
					});
				}
			} catch (error) {
				logEvent("slot_proxy_refresh_failed", {
					slot: slotId,
					reason: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return entry;
	}

	async function readRequestBody(req: any): Promise<Buffer> {
		const chunks: Buffer[] = [];
		for await (const chunk of req) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}
		return Buffer.concat(chunks);
	}

	async function handleProxyRequest(req: any, res: any): Promise<void> {
		// external: Pi Codex transport attempts WebSocket before falling back to SSE.
		if (typeof req.headers?.upgrade === "string") {
			logEvent("slot_proxy_upgrade_refused", { upgrade: req.headers.upgrade });
			res.writeHead(501, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "this route serves HTTP only" } }));
			return;
		}
		const parsed = parseProxyPath(req.url ?? "");
		const presentedEntry = parsed ? readAuthFile()[parsed.slotId] : undefined;
		const presentedSecret = presentedEntry?.type === "oauth" ? presentedEntry.access :
			presentedEntry?.type === "api_key" ? presentedEntry.key : undefined;
		const verdict = admitRequest({
			rawUrl: req.url ?? "",
			headers: req.headers ?? {},
			routes: slotProxyCoordinator?.server ? slotProxyCoordinator.routes : slotProxyRoutes,
			acceptedSecrets: presentedSecret ? [presentedSecret] : [],
		});
		if (!verdict.ok) {
			logEvent("slot_proxy_refused", { status: verdict.status, reason: verdict.message });
			res.writeHead(verdict.status, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: verdict.message } }));
			return;
		}
		const credential = await credentialForProxy(verdict.route.slotId);
		const shaped = shapeUpstreamRequest({
			route: verdict.route,
			rest: verdict.rest ?? "/",
			headers: req.headers ?? {},
			credential,
		});
		if (!shaped.ok) {
			logEvent("slot_proxy_no_credential", {
				slot: verdict.route.slotId,
				status: shaped.status,
			});
			res.writeHead(shaped.status, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: shaped.message } }));
			return;
		}

		let body: Buffer | undefined =
			req.method === "GET" || req.method === "HEAD" ? undefined : await readRequestBody(req);
		if (body && verdict.route.family === "anthropic" && credential?.type === "oauth") {
			try {
				const parsed = JSON.parse(body.toString("utf8"));
				const reshaped = shapeAnthropicOAuthPayload(parsed);
				if (reshaped && reshaped !== parsed) body = Buffer.from(JSON.stringify(reshaped));
			} catch {
			}
		}

		if (res.destroyed) return;
		const upstreamAbort = new AbortController();
		const callerClosed = () => {
			if (!res.writableFinished) upstreamAbort.abort();
		};
		res.once("close", callerClosed);
		try {
			const upstream = await fetch(shaped.url, {
				method: req.method ?? "POST",
				headers: shaped.headers,
				body: body && body.length ? new Uint8Array(body) : undefined,
				signal: upstreamAbort.signal,
			});
			const outgoing: Record<string, string> = {};
			upstream.headers.forEach((value, name) => {
				if (name === "content-length" || name === "content-encoding") return;
				outgoing[name] = value;
			});
			res.writeHead(upstream.status, outgoing);
			if (upstream.body) {
				await new Promise<void>((resolve) => {
					const stream = Readable.fromWeb(upstream.body as any);
					stream.on("error", () => { res.destroy(); resolve(); });
					res.on("close", () => resolve());
					stream.pipe(res);
					res.on("finish", () => resolve());
				});
			} else {
				res.end();
			}
			if (!upstreamAbort.signal.aborted) logEvent("slot_proxy_forwarded", {
				slot: verdict.route.slotId,
				status: upstream.status,
			});
		} catch (error) {
			if (upstreamAbort.signal.aborted || res.destroyed) return;
			const reason = error instanceof Error ? error.message : String(error);
			logEvent("slot_proxy_upstream_failed", { slot: verdict.route.slotId, reason });
			if (!res.headersSent) {
				res.writeHead(502, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: `upstream request failed: ${reason}` } }));
			} else {
				res.end();
			}
		} finally {
			res.off("close", callerClosed);
		}
	}

	function startSlotProxy(): Promise<number | undefined> {
		if (slotProxyPort !== undefined) return Promise.resolve(slotProxyPort);
		const coordinator = slotProxyCoordinator;
		if (coordinator?.server?.listening) {
			slotProxyPort = SLOT_PROXY_PORT;
			return Promise.resolve(SLOT_PROXY_PORT);
		}
		if (coordinator?.starting) {
			return coordinator.starting.then((port) => {
				if (port === SLOT_PROXY_PORT && coordinator.server?.listening) {
					slotProxyPort = SLOT_PROXY_PORT;
					return SLOT_PROXY_PORT;
				}
				return startSlotProxy();
			});
		}
		if (slotProxyStarting) return slotProxyStarting;
		slotProxyStarting = new Promise<number | undefined>((resolve) => {
			let retriedOnEphemeralPort = false;
			let canonicalListener = false;
			const readyHandler = () => {
				if (!canonicalListener) return handleProxyRequest;
				const owner = coordinator?.handlerOwner;
				const member = owner ? coordinator?.members.get(owner) : undefined;
				return member?.ready ? member.handleRequest : undefined;
			};
			const server = createServer(async (req, res) => {
				let handler = readyHandler();
				while (!handler && Date.now() < (coordinator?.handoffUntil ?? 0)) {
					await new Promise((resolveWait) => setTimeout(resolveWait, 25));
					handler = readyHandler();
				}
				if (!handler) {
					res.writeHead(503, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: { message: "slot proxy handoff in progress" } }));
					return;
				}
				handler(req, res).catch((error) => {
					logEvent("slot_proxy_handler_failed", {
						reason: error instanceof Error ? error.message : String(error),
					});
					try {
						if (!res.headersSent) res.writeHead(500);
						res.end();
					} catch {
					}
				});
			});
			server.on("upgrade", (_req: any, socket: any) => {
				try {
					socket.destroy();
				} catch {
				}
			});
			server.on("error", (error: NodeJS.ErrnoException) => {
				if (
					error.code === "EADDRINUSE" &&
					server.listening === false &&
					!slotProxyPort &&
					!retriedOnEphemeralPort
				) {
					retriedOnEphemeralPort = true;
					slotProxyForeignOwner = true;
					logEvent("slot_proxy_foreign_owner", { port: SLOT_PROXY_PORT });
					setImmediate(() => {
						try {
							server.listen(0, "127.0.0.1");
						} catch (retryError) {
							logEvent("slot_proxy_listen_failed", {
								reason: retryError instanceof Error ? retryError.message : String(retryError),
							});
							resolve(undefined);
						}
					});
					return;
				}
				logEvent("slot_proxy_listen_failed", { reason: error.message });
				resolve(undefined);
			});
			server.once("listening", () => {
				const address = server.address();
				const port = typeof address === "object" && address ? address.port : undefined;
				if (port === SLOT_PROXY_PORT && coordinator) {
					if (coordinator.members.size === 0) {
						server.close();
						resolve(undefined);
						return;
					}
					coordinator.server = server;
					canonicalListener = true;
					coordinator.publisher = [...coordinator.members.keys()].at(-1);
				}
				if (sessionClosed && port !== SLOT_PROXY_PORT) {
					server.close();
					resolve(undefined);
					return;
				}
				slotProxyPort = port;
				slotProxyServer = server;
				server.unref();
				logEvent("slot_proxy_listening", { port });
				resolve(port);
			});
			server.listen(SLOT_PROXY_PORT, "127.0.0.1");
		}).finally(() => {
			if (coordinator && coordinator.starting === slotProxyStarting) coordinator.starting = undefined;
			if (coordinator && coordinator.members.size === 0 && coordinators.get(SLOT_PROXY_PORT) === coordinator) {
				coordinators.delete(SLOT_PROXY_PORT);
			}
			slotProxyStarting = undefined;
		});
		if (coordinator) coordinator.starting = slotProxyStarting;
		return slotProxyStarting;
	}

	function releaseSharedProxy(coordinator: SharedProxyCoordinator, cleanupWithoutProxy: boolean): void {
		if (coordinator.handoffTimer) clearTimeout(coordinator.handoffTimer);
		coordinator.handoffTimer = undefined;
		coordinator.handoffUntil = undefined;
		if (coordinator.server) {
			coordinator.routes.clear();
			restoreChildFacingAuth();
			unprovisionOwnLoopbacks();
			try { coordinator.server.close(); } catch {  }
			coordinator.server = undefined;
		}
		if (!coordinator.server && cleanupWithoutProxy) {
			unprovisionOwnLoopbacks();
			restoreChildFacingAuth();
		}
		if (!coordinator.starting && coordinators.get(SLOT_PROXY_PORT) === coordinator) {
			coordinators.delete(SLOT_PROXY_PORT);
		}
		coordinator.routes.clear();
	}

	// external: Pi reload rebuilds its model registry between session_shutdown and session_start.
	function handOffSharedProxy(coordinator: SharedProxyCoordinator, cleanupWithoutProxy: boolean): void {
		const handoffMs = Number(process.env.PI_MULTI_ACCOUNT_HANDOFF_MS) || 30_000;
		coordinator.handlerOwner = undefined;
		coordinator.publisher = undefined;
		coordinator.handoffUntil = Date.now() + handoffMs;
		if (coordinator.handoffTimer) clearTimeout(coordinator.handoffTimer);
		coordinator.handoffTimer = setTimeout(() => {
			coordinator.handoffTimer = undefined;
			if (coordinator.members.size > 0) return;
			logEvent("slot_proxy_handoff_expired", { port: SLOT_PROXY_PORT, waitedMs: handoffMs });
			releaseSharedProxy(coordinator, cleanupWithoutProxy);
		}, handoffMs);
		coordinator.handoffTimer.unref?.();
		logEvent("slot_proxy_handoff", { port: SLOT_PROXY_PORT, waitMs: handoffMs });
	}

	function stopSlotProxy(reason?: string) {
		const sameProcessRestarts = reason === "reload" || reason === "new" || reason === "resume" || reason === "fork";
		const coordinator = slotProxyCoordinator;
		if (coordinator) {
			const member = coordinator.members.get(activationOwner);
			const cleanupWithoutProxy = !config.childProxy && ownsSharedChildPublication();
			if (member) {
				coordinator.members.delete(activationOwner);
				if (member.sessionId && coordinator.sessionOwners.get(member.sessionId) === activationOwner) {
					coordinator.sessionOwners.delete(member.sessionId);
				}
				if (coordinator.publisher === activationOwner) coordinator.publisher = readyProxyOwner(coordinator);
				if (coordinator.handlerOwner === activationOwner) coordinator.handlerOwner = readyProxyOwner(coordinator);
			}
			if (slotProxyServer && slotProxyServer !== coordinator.server) {
				try { slotProxyServer.close(); } catch {  }
			}
			if (member && coordinator.members.size === 0) {
				if (sameProcessRestarts && coordinator.server?.listening) handOffSharedProxy(coordinator, cleanupWithoutProxy);
				else releaseSharedProxy(coordinator, cleanupWithoutProxy);
			}
			slotProxyCoordinator = undefined;
			slotProxyServer = undefined;
			slotProxyPort = undefined;
			slotProxyRoutes.clear();
			return;
		}
		const publishedSharedFiles = ownsSharedChildPublication();
		try { slotProxyServer?.close(); } catch {  }
		slotProxyServer = undefined;
		slotProxyPort = undefined;
		slotProxyRoutes.clear();
		if (!publishedSharedFiles) return;
		restoreChildFacingAuth();
		unprovisionOwnLoopbacks();
	}

	async function publishProxiedSlots(ctx: any): Promise<void> {
		if (!config.childProxy) return;
		slotProxyContext = ctx ?? slotProxyContext;
		const coordinator = slotProxyCoordinator;
		if (coordinator?.server?.listening && coordinator.members.has(activationOwner) && !sessionClosed) {
			coordinator.publisher = activationOwner;
		}
		const parent = readAuthFile();
		const slots = [
			...new Set([
				...registeredSlots,
				...Object.keys(parent).filter((id) => proxyFamilyOf(id) !== undefined),
			]),
		].filter((id) => proxyFamilyOf(id) !== undefined && isEntryUsable(parent[id]));
		if (slots.length === 0) {
			if (ownsSharedChildPublication()) {
				coordinator?.routes.clear();
				unprovisionOwnLoopbacks();
			}
			slotProxyRoutes.clear();
			activateSharedProxy();
			return;
		}
		const port = await startSlotProxy();
		if (sessionClosed) return;
		if (port === SLOT_PROXY_PORT && coordinator?.members.has(activationOwner)) {
			coordinator.publisher = activationOwner;
		}
		if (port === undefined) {
			if (ownsSharedChildPublication()) {
				restoreChildFacingAuth();
				unprovisionOwnLoopbacks();
			}
			return;
		}
		for (const id of slots) {
			const family = proxyFamilyOf(id);
			if (family) slotProxyRoutes.set(id, { slotId: id, family });
		}
		if (!ownsSharedChildPublication()) {
			logEvent("slot_proxy_local_routes_ready", { port, slots });
			activateSharedProxy();
			return;
		}
		coordinator?.routes.clear();
		for (const id of slots) {
			const family = proxyFamilyOf(id);
			if (family) coordinator?.routes.set(id, { slotId: id, family });
		}
		for (const [owner, member] of coordinator?.members ?? []) {
			if (owner === activationOwner || member.proxyEnabled) continue;
			if (!member.prepareRoutes(slots, port)) return;
			member.ready = true;
		}
		shadowChildFacingAuth(slots);
		for (const id of slots) {
			const family = proxyFamilyOf(id);
			if (!family) continue;
			const oauth = parent[id]?.type === "oauth";
			const baseUrl = oauth ? publishedRouteFor(port, id) :
				family === "anthropic" ? "https://api.anthropic.com" : "https://chatgpt.com/backend-api";
			if (family === "anthropic") {
				await publishNativeSlot(id, {
					api: "anthropic-messages",
					baseUrl,
					apiKey: oauth ? placeholderKeyFor(family) : undefined,
					models: anthropicSlotModelIds().map((modelId) => ({
						...anthropicModelDef(modelId, id),
						baseUrl,
					})),
				});
			} else {
				const cached = codexModelCatalogByProvider.get(id)?.models as
					| Array<Record<string, unknown>>
					| undefined;
				const models = (cached?.length ? cached : DEFAULT_CODEX_MODELS.map(codexModelDef)) as Array<
					Record<string, unknown>
				>;
				await publishNativeSlot(id, {
					api: "openai-codex-responses",
					baseUrl,
					apiKey: oauth ? placeholderKeyFor(family) : undefined,
					models,
				});
			}
		}
		if (sessionClosed || !ownsSharedChildPublication()) return;
		activateSharedProxy();
		logEvent("slot_proxy_published", { port, slots });
	}

	function completionFailurePatterns(): RouteFailurePatterns {
		return {
			ignore: config.ignoreErrorPatterns,
			auth: config.authErrorPatterns,
			limit: config.limitErrorPatterns,
			transient: config.transientErrorPatterns,
			model: config.modelErrorPatterns,
			contextOverflow: DEFAULT_IGNORE_PATTERNS,
		};
	}

	function routeReadiness(ctx: any, route: RouteModelRef) {
		const model = findModelIncludingHidden(ctx, route.provider, route.id);
		const now = Date.now();
		const hasAuth = model ? providerHasUsableAuth(ctx, route.provider) : false;
		const invalidated = isInvalidated(route.provider);
		const recoveryAt = providerRecoveryAt(route.provider, now);
		const modelUntil = model ? (exhaustedUntilByModel.get(ref(model.provider, model.id)) ?? 0) : 0;
		const ready = !!model && hasAuth && !invalidated && recoveryAt <= now && modelUntil <= now;
		return { model, now, hasAuth, invalidated, recoveryAt, modelUntil, ready };
	}

	function usableCompletionRoute(ctx: any, route: RouteModelRef): RouteModelRef | undefined {
		const { model, now, hasAuth, invalidated, recoveryAt, modelUntil, ready } = routeReadiness(ctx, route);
		if (!ready) {
			logEvent("completion_route_unusable", {
				provider: route.provider,
				id: route.id,
				found: !!model,
				hasAuth,
				invalidated,
				recoveryMs: recoveryAt - now,
				modelUntilMs: modelUntil - now,
			});
			return undefined;
		}
		return { provider: model.provider, id: model.id };
	}

	function completionFallbackCandidates(ctx: any, request: RouteRequestFact): RouteModelRef[] {
		const sourceRef = request.previous?.model ?? request.sessionModel;
		const sourceModel = sourceRef
			? findModelIncludingHidden(ctx, sourceRef.provider, sourceRef.id) ?? sourceRef
			: ctx.model;
		if (!sourceModel?.provider || !sourceModel?.id) return [];
		return findFallbackModels(ctx, sourceModel, {
			availableNowOnly: true,
			includeCurrent: true,
			preserveQualityBand: true,
		}).map((model: any) => ({ provider: model.provider, id: model.id }));
	}

	async function observeBackgroundCompletionAttempt(attempt: RouteAttemptFact): Promise<void> {
		const kind = classifyRouteAttempt(attempt, completionFailurePatterns());
		const provider = attempt.model.provider;
		const modelId = attempt.model.id;
		const errorText = attempt.errorMessage ?? "";
		logEvent("background_completion_attempt", {
			operationId: attempt.operationId,
			purpose: attempt.purpose,
			attempt: attempt.attempt,
			provider,
			model: modelId,
			dispatched: attempt.dispatched,
			status: attempt.response?.status ?? null,
			classified: kind,
			error: errorText,
		});
		switch (kind) {
			case "success":
				noteAuthSuccess(provider, modelId);
				return;
			case "auth":
				markAuthFailure(provider, errorText || `HTTP ${attempt.response?.status ?? 401}`);
				return;
			case "limit": {
				const inferred = await resolveLimitCooldownMs(
					completionRouterContext,
					provider,
					errorText || `HTTP ${attempt.response?.status ?? 429}`,
				);
				markExhausted(provider, Math.max(inferred, attempt.response?.retryAfterMs ?? 0));
				return;
			}
			case "model":
				markModelExhausted(attempt.model, config.transientCooldownMs);
				return;
			case "cursor_stall":
			case "transient":
				markExhausted(provider, config.transientCooldownMs);
				return;
			case "aborted":
			case "context_overflow":
			case "route_unavailable":
			case "unhandled":
				return;
			default: {
				const exhaustive: never = kind;
				return exhaustive;
			}
		}
	}

	pi.events.on(MODEL_ROUTE_REQUEST_EVENT, (raw: unknown) => {
		if (!raw || typeof raw !== "object") return;
		const request = raw as ModelRouteRequest;
		if (request.result !== undefined || request.version !== 1) return;
		const ctx = completionRouterContext;
		if (!ctx || !automaticFailoverEnabled()) return;
		const asked = request.model;
		if (typeof asked?.provider !== "string" || typeof asked?.id !== "string") return;
		const readiness = routeReadiness(ctx, asked);
		if (!readiness.model || readiness.ready) {
			request.result = { action: "keep" };
			return;
		}
		const picks = findFallbackModels(ctx, readiness.model, {
			availableNowOnly: true,
			preserveQualityBand: true,
			ignoreSavedDefault: true,
		});
		const pick = picks.find((model: any) => model.provider === ctx.model?.provider) ?? picks[0];
		const blocked = readiness.invalidated
			? "is logged out or invalid"
			: !readiness.hasAuth
				? "has no usable login"
				: `is spent for ~${formatUntil(Math.max(readiness.recoveryAt, readiness.modelUntil))}`;
		request.result = pick
			? {
					action: "route",
					model: { provider: pick.provider, id: pick.id },
					reason: `${asked.provider}/${asked.id} ${blocked}`,
				}
			: { action: "keep", reason: `${asked.provider}/${asked.id} ${blocked}; no ready account has the same tier` };
		logEvent("model_route_request", {
			purpose: request.purpose,
			asked,
			result: request.result,
		});
	});

	const completionHost = pi as ExtensionAPI & HostCompletionRouterAPI;
	if (typeof completionHost.registerCompletionRouter === "function") {
		completionHost.registerCompletionRouter({
			select: (rawRequest) => {
				const ctx = completionRouterContext;
				if (!ctx || sessionClosed || !automaticFailoverEnabled()) {
					return { action: "stop", reason: "Multi-account completion routing is not active" };
				}
				const request: RouteRequestFact = {
					...rawRequest,
					preferredModels: rawRequest.preferredModels
						.map((route) => usableCompletionRoute(ctx, route))
						.filter((route): route is RouteModelRef => route !== undefined),
					sessionModel: rawRequest.sessionModel
						? usableCompletionRoute(ctx, rawRequest.sessionModel)
						: undefined,
				};
				const orderedCandidates = completionFallbackCandidates(ctx, request);
				const decision = selectOperationRoute({
					request,
					orderedCandidates,
					patterns: completionFailurePatterns(),
					maxSameRouteTransientRetries: 1,
					transientRetryDelayMs: Math.min(config.transientCooldownMs, 1_000),
				});
				logEvent("completion_route_select", {
					operationId: rawRequest.operationId,
					purpose: rawRequest.purpose,
					attempt: rawRequest.attempt,
					rawSession: rawRequest.sessionModel,
					rawPreferred: rawRequest.preferredModels,
					sessionModel: request.sessionModel ?? null,
					preferred: request.preferredModels,
					candidates: orderedCandidates,
					decision,
				});
				return decision;
			},
			onAttempt: observeBackgroundCompletionAttempt,
		});
	}

	function preflightHostCapabilities(ctx: any) {
		const has = (name: string) =>
			typeof (pi as unknown as Record<string, unknown>)[name] === "function";
		const caps = {
			setModel: has("setModel"),
			registerProvider: has("registerProvider"),
			sendUserMessage: has("sendUserMessage"),
			continueAgent: has("continueAgent"),
			on: has("on"),
			registerCommand: has("registerCommand"),
			registerCompletionRouter: has("registerCompletionRouter"),
		};
		const canSwitch = caps.setModel;
		const canResume = caps.continueAgent || caps.sendUserMessage;
		const seamlessResume = caps.continueAgent;
		logEvent("host_capabilities", {
			version: VERSION,
			sourceFingerprint: LOADED_SOURCE_FINGERPRINT,
			...caps,
			canSwitch,
			canResume,
			seamlessResume,
			...(oauthUnavailable ? { oauthUnavailable } : {}),
		});
		if (!preflightNotified) {
			preflightNotified = true;
			if (oauthUnavailable) {
				ctx.ui?.notify?.(
					`pi-multi-account v${VERSION}: subscription (OAuth) logins are unavailable — ${oauthUnavailable}`,
					"warning",
				);
			}
			if (!canSwitch) {
				ctx.ui?.notify?.(
					`pi-multi-account v${VERSION}: this Pi build does not expose pi.setModel() — automatic account switching is IMPOSSIBLE on this host, so failover cannot work until it is restored. Check your @earendil-works/pi-coding-agent version.`,
					"error",
				);
			} else if (!canResume) {
				ctx.ui?.notify?.(
					`pi-multi-account v${VERSION}: this Pi build exposes neither pi.continueAgent() nor pi.sendUserMessage() — after a switch the task cannot auto-continue; you will have to re-send your prompt on the new account.`,
					"warning",
				);
			} else if (!seamlessResume) {
				ctx.ui?.notify?.(
					`pi-multi-account v${VERSION}: seamless in-place resume (pi.continueAgent) is not available on this Pi build — automatic recovery resumes from the preserved task context in a fresh turn. Temporary errors keep the same provider/model; confirmed quota limits retain failover. This is the expected fallback, not an error.`,
					"info",
				);
			}
		}
		return { canSwitch, canResume, seamlessResume };
	}

	safeOn("session_start", async (_event, ctx) => {
		const startEpoch = ++chainEpoch;
		sessionClosed = false;
		hostOwnsSessionModel = typeof ctx?.sessionManager?.getBranch === "function";
		const rawSessionId = ctx?.sessionManager?.getSessionId?.();
		const sessionId = typeof rawSessionId === "string" && rawSessionId.length > 0
			? rawSessionId : undefined;
		if (hostOwnsSessionModel && !subagentChild && !multiSessionHost) {
			const previous = activations[activationKey];
			if (previous && previous.owner !== activationOwner) {
				if (sessionId && previous.sessionId === sessionId && typeof previous.relinquish === "function") {
					previous.relinquish();
				} else {
					subagentChild = true;
				}
			}
			if (!subagentChild) activations[activationKey] = {
				owner: activationOwner, sessionId, relinquish: relinquishRoot,
			};
		}
		if (!subagentChild) joinSharedProxy(sessionId);
		startupModel = ctx?.model;
		if (hostOwnsSessionModel && !subagentChild) {
			const changes = ctx.sessionManager.getBranch().filter((entry: any) => entry.type === "model_change");
			const last = changes.at(-1);
			if (last?.provider && last?.modelId) startupModel = { provider: last.provider, id: last.modelId };
			if (!explicitCli.thinking && config.reasoningLevel === "auto") desiredThinkingLevel = readThinkingLevel();
		}
		completionRouterContext = subagentChild ? undefined : ctx;
		manualRouteOwnsErrors = false;
		lastObservedModelKey = thinkingModelKey(ctx);
		lastObservedThinkingLevel = readThinkingLevel();
		pendingModelThinkingChange = undefined;
		if (!explicitCliThinkingLevel) {
			const resolved = await resolveExplicitCliModelThinkingLevel(
				explicitCliArgs,
				ctx,
			);
			if (sessionClosed || chainEpoch !== startEpoch) return;
			if (resolved) {
				explicitCli.thinking = true;
				explicitCliThinkingLevel = resolved;
				desiredThinkingLevel = resolved;
			}
		}
		if (!subagentChild) preflightHostCapabilities(ctx);
		checkPiContract(ctx, "session_start");
		slotProxyContext = ctx;
		if (config.childProxy) {
			await startSlotProxy();
		} else if (slotProxyCoordinator) {
			const cohort = slotProxyCoordinator;
			if (cohort.starting) await cohort.starting;
			if (cohort.server?.listening) prepareSharedRoutes([...cohort.routes.keys()], SLOT_PROXY_PORT);
		}
		if (sessionClosed || chainEpoch !== startEpoch) return;
		refreshDiscovery(true, ctx);
		await publishProxiedSlots(ctx);
		if (!config.childProxy) activateSharedProxy();
		await publishOwnedNativeAliases(ctx);
		if (config.includeCursor) await refreshCursorSlots(readAuthFile(), ctx);
		applyOnlyActiveFilter(ctx);
		pruneCooldowns();
		if (
			!subagentChild &&
			((persistedState.pendingFrom && persistedState.pendingReason) ||
				persistedState.pendingContinuationPrompt)
		)
			clearPendingContinuation({ allowLegacy: true });
		autoContinuesThisPrompt = 0;
		resetGovernor();
		startFreshFailoverChain();
		userAbortedChain = false;
		watchdogAborting = false;
		expectingInjectedContinuation = false;
		recoveryFailures = 0;
		breakerOpenUntil = 0;
		responseCooldownHints.clear();
		handledAssistantErrors.clear();
		clearQueuedInputs();
		logEvent("session_start", {
			session: sessionInstanceId,
			version: VERSION,
			enabled: automaticFailoverEnabled(),
			mode: subagentChild ? "subagent-child-passive" : "interactive",
			rotation: rotation.length,
		});
		ctx.ui.notify(
			subagentChild
				? `pi-multi-account v${VERSION} loaded in passive pi-subagents child mode. Model routing remains owned by the parent runner.`
				: `pi-multi-account v${VERSION} loaded (${config.enabled ? "enabled" : "disabled"}). ${rotation.length} account(s) in rotation. Config: ${CONFIG_PATH}`,
			"info",
		);
		if (duplicateSlots.length > 0) {
			ctx.ui.notify(
				`pi-multi-account: duplicate account slot(s) skipped: ${duplicateSlots.map(({ duplicate, primary }) => `${duplicate} duplicates ${primary}`).join(", ")}. Log the duplicate slot into a different account.`,
				"warning",
			);
		}
		await refreshAccountMetadata(ctx, { usage: !subagentChild, force: false });
		if (sessionClosed || chainEpoch !== startEpoch) return;
		// external: Pi restores the selected session model before extension catalogs finish registering.
		if (cursorReady) await cursorReady.catch(() => undefined);
		if (sessionClosed || chainEpoch !== startEpoch) return;
		applyOnlyActiveFilter(ctx);
		if (!subagentChild) {
			await restoreRememberedModel(ctx);
			if (sessionClosed || chainEpoch !== startEpoch) return;
			await ensureReadyModel(
				ctx,
				"startup preflight: selected account unavailable",
			);
		}
		if (sessionClosed || chainEpoch !== startEpoch) return;
		startUsageStatusTimer(ctx);
	});

	safeOn("session_shutdown", async (event, ctx) => {
		chainEpoch++;
		if (activations[activationKey]?.owner === activationOwner) delete activations[activationKey];
		sessionClosed = true;
		completionRouterContext = undefined;
		if (!supersededRoot) rememberUserModel(ctx?.model);
		if (pendingWakeTimer) {
			clearTimeout(pendingWakeTimer);
			pendingWakeTimer = undefined;
		}
		clearQueuedInputs();
		if (!subagentChild) clearPendingContinuation();
		flushUsageTelemetry();
		clearUsageStatusTimer();
		contextGuardWantsCompaction = false;
		contextGuardCompactionRetryAfter = 0;
		settleContextGuardCompaction();
		endResumeWatch();
		await Promise.all(pendingNativePublications);
		stopSlotProxy(event?.reason);
		watchdogAborting = false;
		expectingInjectedContinuation = false;
		userAbortedChain = false;
		autoContinuesThisPrompt = 0;
		manualPinnedProvider = undefined;
		failoverPinnedProvider = undefined;
		responseCooldownHints.clear();
		handledAssistantErrors.clear();
		ctx?.ui?.setStatus?.("multi-account-quota", undefined);
	});

	safeOn("session_before_compact", async (event: any, ctx: any) => {
		if (recoveryArbiter.policyRefusalStopped) {
			if (event?.reason === "manual") return undefined;
			return compactionCancelled("automatic compaction stopped after provider policy refusal");
		}
		if (!automaticFailoverEnabled() || isFailoverExempt(ctx.model?.provider)) return undefined;
		if (event?.reason === "overflow") lastContextOverflowAt = Date.now();
		const result = await runHealthyCompaction(event, ctx);
		if (result !== undefined) return result;
		// external: Pi default compaction uses the active account without a timeout.
		if (queuedUserInputs.length > 0) {
			const flushDelay = nextModelAvailabilityDelayMs(ctx);
			if (flushDelay !== undefined && flushDelay <= QUEUE_FLUSH_SOON_MS) {
				return { cancel: true, reason: "compaction cancelled: failover queue must flush" };
			}
			logEvent("compaction_allowed_over_queue", {
				queued: queuedUserInputs.length,
				flushDelayMs: flushDelay ?? null,
			});
		}
		if (
			config.routeCompactionToHealthyAccount &&
			(!isCurrentModelReady(ctx) ||
				isCursorProviderId(ctx.model?.provider ?? ""))
		) {
			return {
				cancel: true,
				reason: isCursorProviderId(ctx.model?.provider ?? "")
					? "Cursor cannot compact natively without hanging"
					: "active account unavailable for compaction",
			};
		}
		return undefined;
	});

	// external: Pi 0.84.3 and later exposes a compaction completion callback.
	safeOn("session_compact_failed", (event: any, ctx: any) => {
		if (contextGuardWantsCompaction || contextGuardCompactionInFlight) {
			failContextGuardCompaction(
				"context_guard_compaction_failed",
				event?.errorMessage ?? (event?.aborted ? "Compaction cancelled" : undefined),
				ctx,
			);
		}
		if (queuedUserInputs.length === 0) return;
		runBackground("post-compaction queued flush", ctx, () =>
			attemptQueuedInputResume(ctx),
		);
	});

	for (const evt of [
		"turn_start",
		"message_start",
		"message_update",
		"tool_execution_update",
	] as const) {
		safeOn(evt, () => {
			noteResumeProgress();
		});
	}
	safeOn("message_start", (_event, ctx) => applyOnlyActiveFilter(ctx));
	safeOn("tool_execution_start", () => {
		toolInFlight++;
		noteResumeProgress();
	});
	safeOn("tool_execution_end", () => {
		toolInFlight = Math.max(0, toolInFlight - 1);
		noteResumeProgress();
	});

	safeOn("input", async (event, ctx) => {
		if (
			!automaticFailoverEnabled() ||
			(event as any).source === "extension"
		)
			return { action: "continue" as const };
		const text =
			typeof (event as any).text === "string" ? (event as any).text : "";
		if (/^\s*[/!]/.test(text)) return { action: "continue" as const };
		claimUserControl("interactive input", true);
		userPromptStartsTurn = true;
		noteRecoveryProgress();
		retireSpentManualPin();
		retireSpentFailoverPin();

		if (!ctx.isIdle()) {
			if ((event as any).streamingBehavior === "steer" || (event as any).streamingBehavior === "followUp") {
				return { action: "continue" as const };
			}
			if (typeof pi.sendUserMessage === "function") {
				await pi.sendUserMessage(queuedInputContent({ text, images: (event as any).images }), {
					deliverAs: "followUp",
				});
				return { action: "handled" as const };
			}
			return { action: "continue" as const };
		}

		if (
			await ensureReadyModel(ctx, "preflight: selected account unavailable")
		) {
			if (!ctx.isIdle()) {
				if (typeof pi.sendUserMessage === "function") {
					await pi.sendUserMessage(queuedInputContent({ text, images: (event as any).images }), {
						deliverAs: "followUp",
					});
					return { action: "handled" as const };
				}
			}
			return { action: "continue" as const };
		}

		const delay = nextModelAvailabilityDelayMs(ctx);
		if (delay !== undefined) {
			logEvent("input_passthrough_while_cooling", {
				session: sessionInstanceId,
				delayMs: delay,
				provider: ctx.model?.provider,
				model: ctx.model?.id,
			});
			ctx.ui.notify(
				config.resumeAfterAllAccountsRecover
					? `pi-multi-account: no account is ready right now. Your message stays in Pi's transcript; if this request is refused, it will resume automatically when a compatible account recovers (next check in ~${formatDelay(delay)}).`
					: `pi-multi-account: no account is ready right now. Your message stays in Pi's transcript, but resumeAfterAllAccountsRecover is off, so a refused request will not be resumed automatically.`,
				"warning",
			);
			return { action: "continue" as const };
		}

		const providers = [
			...new Set(
				activeFallbacks()
					.map((target) => parseTarget(target)?.provider)
					.filter(Boolean),
			),
		];
		const slotHint =
			providers.length > 0 ? ` Select one of: ${providers.join(", ")}.` : "";
		const auth = readAuthFile();
		const deadAuth = [...invalidatedByProvider.keys()].filter((provider) =>
			isEntryUsable(auth[provider]),
		);
		const unconfigured = unconfiguredRotationMembers(ctx);
		if (deadAuth.length > 0 || unconfigured.length > 0) {
			const parts: string[] = [];
			if (deadAuth.length > 0)
				parts.push(
					`${deadAuth.join(", ")} — authorization expired, so re-login is the only fix: run /login, choose "Use a subscription", then select each of them`,
				);
			if (unconfigured.length > 0)
				parts.push(
					`${unconfigured.join(", ")} — logged in, but Pi knows no model for them, so they cannot be selected`,
				);
			ctx.ui.notify(
				`Provider failover: every account is currently unusable. ${parts.join(". ")}.`,
				"error",
			);
			return { action: "continue" as const };
		}
		ctx.ui.notify(
			`Provider failover: no usable authenticated account exists. Run /login, choose "Use a subscription", then select an account slot.${slotHint}`,
			"error",
		);
		return { action: "continue" as const };
	});

	safeOn("before_agent_start", async (_event, ctx) => {
		if (subagentChild) return;
		if (expectingInjectedContinuation) {
			expectingInjectedContinuation = false;
			continuationDispatchedForAgentTurn = true;
			await ensureReadyModel(
				ctx,
				"last-moment preflight: selected account unavailable",
			);
			return;
		}
		claimUserControl("before agent start");
		await ensureReadyModel(
			ctx,
			"last-moment preflight: selected account unavailable",
		);
	});

	safeOn("agent_start", async (_event, ctx) => {
		exhaustedGateAborting = false;
		const userProbe = userPromptStartsTurn;
		userPromptStartsTurn = false;
		if (gateExhaustedTurn(ctx, userProbe)) return;
		noteResumeProgress();
		currentPromptSwitch = undefined;
		automaticModelTarget = undefined;
		responseCooldownHints.clear();
		handledAssistantErrors.clear();
		captureDesiredThinking(ctx);
		refreshDiscovery(false, ctx);
		if (pendingSettingsCheck) {
			pendingSettingsCheck = false;
			checkPiContract(ctx, "after_model_switch", true);
		}
		if (!usageStatusTimer) startUsageStatusTimer(ctx);
		updateUsageStatus(ctx);
	});

	safeOn("thinking_level_select", (event, ctx) => {
		if (subagentChild) return;
		const level = (event as any).level;
		if (thinkingRank(level) < 0) return;
		const appliedLevel = level as ReasoningLevel;
		const previousLevel = (event as any).previousLevel;
		const previouslyObserved = lastObservedThinkingLevel;
		if (thinkingChangeSource.getStore() === "extension") {
			lastObservedThinkingLevel = appliedLevel;
			return;
		}
		if (internalModelChanges > 0) {
			lastObservedThinkingLevel = appliedLevel;
			return;
		}
		const modelKey = thinkingModelKey(ctx);
		if (
			pendingModelThinkingChange?.model === modelKey &&
			pendingModelThinkingChange.previousLevel === previousLevel &&
			pendingModelThinkingChange.appliedLevel === appliedLevel
		) {
			pendingModelThinkingChange = undefined;
			lastObservedThinkingLevel = appliedLevel;
			return;
		}
		// external: Pi applies model thinking defaults and clamps before model_select.
		if (
			lastObservedModelKey &&
			modelKey !== "unknown" &&
			modelKey !== lastObservedModelKey &&
			thinkingRank(previousLevel) >= 0 &&
			previousLevel === previouslyObserved
		) {
			pendingModelThinkingChange = {
				model: modelKey,
				previousLevel,
				appliedLevel,
			};
			lastObservedThinkingLevel = appliedLevel;
			return;
		}
		lastObservedThinkingLevel = appliedLevel;
		thinkingPreferenceChanged = true;
		desiredThinkingLevel = appliedLevel;
		thinkingClamp = undefined;
		rememberUserModel(ctx?.model);
	});

	safeOn("model_select", (event, ctx) => {
		const model = (event as any).model;
		if (!model?.provider || !model?.id || subagentChild) return;
		// external: Pi versions through 0.84.2 persist user model switches as the global default.
		pendingSettingsCheck = piAutoPersistsSelectedModel(PI_HOST_VERSION);
		updateUsageStatus(ctx, model.provider);
		runBackground("model_select usage refresh", ctx, () =>
			refreshUsage(ctx, model.provider),
		);
		const selected = ref(model.provider, model.id);
		const appliedThinkingLevel = readThinkingLevel();
		const pendingThinking = pendingModelThinkingChange;
		pendingModelThinkingChange = undefined;
		if (
			pendingThinking?.model === selected &&
			(!appliedThinkingLevel || pendingThinking.appliedLevel === appliedThinkingLevel)
		) {
			thinkingClamp = {
				model: selected,
				level: pendingThinking.appliedLevel,
			};
		} else if (
			appliedThinkingLevel &&
			lastObservedThinkingLevel &&
			appliedThinkingLevel !== lastObservedThinkingLevel
		) {
			pendingModelThinkingChange = {
				model: selected,
				previousLevel: lastObservedThinkingLevel,
				appliedLevel: appliedThinkingLevel,
			};
			thinkingClamp = { model: selected, level: appliedThinkingLevel };
		}
		if (appliedThinkingLevel) lastObservedThinkingLevel = appliedThinkingLevel;
		lastObservedModelKey = selected;
		if (automaticWarmupTarget === selected) {
			automaticWarmupTarget = undefined;
			return;
		}
		if (automaticModelTarget === selected) {
			automaticModelTarget = undefined;
			rememberUserModel(model);
			return;
		}
		if ((event as any).source === "restore") return;
		if (config.reasoningLevel === "auto" && !explicitCli.thinking && appliedThinkingLevel) {
			desiredThinkingLevel = appliedThinkingLevel;
			thinkingClamp = undefined;
		}
		modelPreferenceChanged = true;
		pendingWarmupUpgrade = undefined;
		rememberUserModel(model);
		claimUserControl("manual model selection", true);
		if (queuedUserInputs.length > 0) {
			runBackground("manual model selection queued input resume", ctx, () =>
				attemptQueuedInputResume(ctx),
			);
		}
	});

	safeOn("after_provider_response", (event, ctx) => {
		const request = (event as any).request as
			| { kind?: string; model?: RouteModelRef }
			| undefined;
		if (request?.kind === "background") {
			const route = request.model;
			if (route && usageFamily(route.provider) === "codex") {
				const auth = readAuthFile();
				const entry = auth[route.provider];
				const snapshot = parseCodexUsageHeaders(
					route.provider,
					(event as any).headers ?? {},
					Date.now(),
					entry ? credentialHash(entry) : undefined,
				);
				if (snapshot) storeUsage(ctx, snapshot, { fromResponseHeaders: true, auth });
			}
			return;
		}
		noteResumeProgress();
		noteProviderRequestObserved();
		if (ctx.model && usageFamily(ctx.model.provider) === "codex") {
			const auth = readAuthFile();
			const entry = auth[ctx.model.provider];
			const snapshot = parseCodexUsageHeaders(
				ctx.model.provider,
				(event as any).headers ?? {},
				Date.now(),
				entry ? credentialHash(entry) : undefined,
			);
			if (snapshot) storeUsage(ctx, snapshot, { fromResponseHeaders: true, auth });
		}
		if (!automaticFailoverEnabled()) return;
		const status = (event as any).status;
		if (status < 400 && ctx.model) {
			noteProviderSuccessObserved();
			noteAuthSuccess(ctx.model.provider, ctx.model.id);
			noteProviderResponseStarted();
			responseCooldownHints.delete(ctx.model.provider);
			return;
		}
		if ((status === 429 || status === 402 || status === 403) && ctx.model) {
			if (
				status !== 429 &&
				!classifyProvider(ctx.model.provider, config.qwenProvider)
			) return;
			const cooldownMs = cooldownFromHeaders((event as any).headers ?? {});
			if (cooldownMs !== undefined) {
				responseCooldownHints.set(
					ctx.model.provider,
					Math.max(
						responseCooldownHints.get(ctx.model.provider) ?? 0,
						cooldownMs,
					),
				);
			}
		}
	});

	safeOn("message_end", async (event, ctx) => {
		if (!isAccountChatModel(ctx.model)) return;
		if (exhaustedGateAborting && (event as any).message?.stopReason === "aborted") return;
		const errorEpoch = chainEpoch;
		const staleError = () => sessionClosed || errorEpoch !== chainEpoch || userAbortedChain || ctx.signal?.aborted;
		const message = (event as any).message;
		if (message?.role !== "assistant" || !automaticFailoverEnabled()) return;
		if (message.stopReason !== "error") {
			exhaustedGateNoticeKey = undefined;
			noteProviderSuccessObserved();
			noteRecoveryProgress();
			if (message.provider) noteAuthSuccess(message.provider, message.model);
			if (pendingWarmupUpgrade && !staleError()) await finishFailoverWarmup(ctx, message);
			return;
		}
		if (userAbortedChain || ctx.signal?.aborted) return;
		const errorText = assistantErrorText(message);
		const provider =
			typeof message.provider === "string"
				? message.provider
				: ctx.model?.provider;
		const modelId =
			typeof message.model === "string" ? message.model : ctx.model?.id;
		if (!provider || !modelId) return;
		const managed = !!classifyProvider(provider, config.qwenProvider);
		const isCurrentModelProvider = provider === ctx.model?.provider;
		if (!managed && !isCurrentModelProvider) return;
		if (manualRouteOwnsErrors && (!isCurrentModelProvider ||
			(ctx.model?.id && !sameModelIdentity(modelId, ctx.model.id)))) return;
		if (isPolicyRefusal(errorText)) {
			stopAutomaticRecoveryForPolicyRefusal(ctx, provider, modelId);
			return;
		}
		const errorKey = `${provider}/${modelId}:${message.timestamp ?? "unknown"}:${errorText}`;
		if (handledAssistantErrors.has(errorKey)) return;
		handledAssistantErrors.add(errorKey);
		manualRouteOwnsErrors = false;
		const failedModel = ctx.modelRegistry.find(provider, modelId) ?? {
			provider,
			id: modelId,
		};
		const temporaryApiThrottle = !managed && isTemporaryApiThrottle(errorText);
		const failureKind = temporaryApiThrottle ? "transient" : classifyRouteAttempt(
			{
				operationId: `foreground:${sessionInstanceId}`,
				purpose: "agent-turn",
				attempt: 1,
				model: { provider, id: modelId },
				dispatched: true,
				stopReason: "error",
				errorMessage: errorText,
			},
			completionFailurePatterns(),
		);
		logEvent("assistant_error", {
			session: sessionInstanceId,
			provider,
			model: modelId,
			classified: failureKind,
			error: errorText,
		});
		if (!(["auth", "limit", "model", "transient", "cursor_stall"] as string[]).includes(failureKind)) return;
		if (failureKind === "limit" || failureKind === "auth") {
			if (hasFailoverPin(provider)) failoverPinnedProvider = undefined;
			if (hasManualPin(provider)) manualPinnedProvider = undefined;
		}
		if (!managed && isFailoverExempt(provider)) {
			logEvent("failover_suppressed", {
				provider,
				model: modelId,
				reason: "neverFailoverProviders",
			});
			return;
		}
		const recoveryCategory: RecoveryCategory = failureKind === "limit"
			? "quota"
			: failureKind === "transient" || failureKind === "cursor_stall"
				? "transient"
				: "unknown";
		const recoveryLease = recoveryArbiter.tryAcquire(
			{
				category: recoveryCategory,
				provider,
				model: modelId,
				sessionId: recoverySessionId(ctx),
			},
			continuationRecoveryLease ?? contextGuardRecoveryLease,
		);
		if (!recoveryLease) {
			logEvent("automatic_recovery_suppressed", { reason: "another automatic recovery is active" });
			return;
		}
		const previousPromptSwitch = currentPromptSwitch;
		recoveryLease.markRecovering(recoveryCategory, provider, modelId);
		try {
		if (!managed) {
			if (failureKind === "transient" || failureKind === "cursor_stall") {
				const retryDelayMs =
					responseCooldownHints.get(provider) ?? config.transientCooldownMs;
				responseCooldownHints.delete(provider);
				retryTemporaryFailure(ctx, failedModel, errorText, retryDelayMs);
				return;
			}
			const accountLevel = failureKind === "limit" || failureKind === "auth";
			if (accountLevel || failureKind === "model") {
				await switchToFallback(
					ctx,
					failedModel,
					`external provider out of quota: ${errorText.slice(0, 100)}`,
					accountLevel ? config.cooldownMs : config.transientCooldownMs,
					{
						scope: accountLevel ? "provider" : "model",
						waitForQuotaRecovery: failureKind === "limit",
					},
				);
			}
			return;
		}

		if (failureKind === "auth") {
			let killed = false;
			let reason = errorText;
			if (
				isRefreshable(provider) &&
				patternMatch(errorText, FORCE_REFRESH_AUTH_ERROR_PATTERNS)
			) {
				const refresh = await forceRefreshProvider(ctx, provider);
				if (staleError()) return;
				if (refresh.status === "refreshed") {
					noteAuthSuccess(provider, modelId);
					const target = ref(provider, modelId);
					currentPromptSwitch = {
						from: target,
						to: target,
						reason:
							"OAuth access token was revoked early and refreshed automatically",
						at: Date.now(),
					};
					ctx.ui.notify(
						`Provider failover: ${provider} access token was invalidated, refreshed successfully, and will retry on the same account.`,
						"info",
					);
					return;
				}
				if (refresh.status === "terminal") {
					reason = `OAuth refresh failed permanently: ${refresh.error}`;
					markInvalid(provider, reason);
					killed = true;
				} else if (refresh.status === "transient") {
					reason = `OAuth refresh failed temporarily: ${refresh.error}`;
					markExhausted(provider, config.transientCooldownMs);
				} else {
					killed = markAuthFailure(provider, errorText);
				}
			} else {
				killed = markAuthFailure(provider, errorText);
			}
			if (killed) {
				const isApiKey = authTypeOfEntry(readAuthFile()[provider]) === "api_key";
				const sharedClientHint =
					!isApiKey &&
					classifyProvider(provider, config.qwenProvider) === "anthropic" &&
					/invalid_grant|revoked/i.test(reason)
						? ' Its refresh token was revoked server-side. Claude Pro/Max logins from every CLI share one client id and Anthropic keeps a single live refresh token per account, so signing this same account into another tool (Claude Code, another machine, or a second slot here) revokes this one. Use a different Claude account per slot, and keep the account another tool is signed into out of this rotation.'
						: "";
				ctx.ui.notify(
					`Provider failover: ${provider} (${isApiKey ? "api_key" : "oauth"}) authorization is invalid. Run /login, choose ${isApiKey ? '"Use an API key"' : '"Use a subscription"'}, then select ${provider}.${sharedClientHint}`,
					"warning",
				);
			}
			const cooldownMs = killed ? 0 : TRANSIENT_AUTH_COOLDOWN_MS;
			await switchToFallback(
				ctx,
				failedModel,
				killed
					? `auth invalid: ${reason.slice(0, 100)}`
					: `transient auth failure: ${reason.slice(0, 100)}`,
				cooldownMs,
			);
			return;
		}
		if (failureKind === "limit") {
			const cooldownMs = await resolveLimitCooldownMs(ctx, provider, errorText);
			if (staleError()) return;
			responseCooldownHints.delete(provider);
			await switchToFallback(
				ctx,
				failedModel,
				`assistant error: ${errorText.slice(0, 120)}`,
				cooldownMs,
				{ waitForQuotaRecovery: true },
			);
			return;
		}
		if (failureKind === "model") {
			await switchToFallback(
				ctx,
				failedModel,
				`model unavailable: ${errorText.slice(0, 120)}`,
				config.transientCooldownMs,
				{ scope: "model" },
			);
			return;
		}
		if (failureKind === "transient" || failureKind === "cursor_stall") {
			retryTemporaryFailure(ctx, failedModel, errorText);
		}
		} finally {
			if (!recoveryArbiter.policyRefusalStopped && currentPromptSwitch !== previousPromptSwitch) {
				const retainedLease =
					[contextGuardRecoveryLease, continuationRecoveryLease].find(
						(lease) => lease?.token === recoveryLease.token,
					) ?? recoveryLease;
				if (continuationRecoveryLease?.token !== retainedLease.token) {
					continuationRecoveryLease?.release();
				}
				continuationRecoveryLease = retainedLease;
			} else {
				recoveryLease.release();
			}
		}
	});

	safeOn("agent_end", async (event, ctx) => {
		const recoveryLease = continuationRecoveryLease ?? contextGuardRecoveryLease;
		try {
		if (!isAccountChatModel(ctx.model)) return;
		if (!automaticFailoverEnabled()) return;
		if (exhaustedGateAborting) {
			exhaustedGateAborting = false;
			endResumeWatch();
			currentPromptSwitch = undefined;
			continuationDispatchedForAgentTurn = false;
			return;
		}
		const stop = lastAssistantStopReason((event as any).messages ?? []);
		if (watchdogAborting) {
			watchdogAborting = false;
			endResumeWatch();
			const failed =
				ctx.model?.provider && ctx.model?.id ? ctx.model : undefined;
			currentPromptSwitch = undefined;
			continuationDispatchedForAgentTurn = false;
			if (failed && config.enabled && config.autoContinue) {
				setPendingContinuation(
					ctx,
					failed,
					`${TRANSIENT_PENDING_PREFIX} interrupted a stuck resume; retrying the same provider and model`,
				);
			}
			return;
		}
		if (stop === "aborted" || ctx.signal?.aborted) {
			chainEpoch++;
			userAbortedChain = true;
			startFreshFailoverChain();
			clearPendingContinuation();
			currentPromptSwitch = undefined;
			continuationDispatchedForAgentTurn = false;
			endResumeWatch();
			return;
		}
		endResumeWatch();
		if (stop !== "error") {
			chainEpoch++;
			clearPendingContinuation();
			currentPromptSwitch = undefined;
			continuationDispatchedForAgentTurn = false;
			return;
		}
		if (continuationDispatchedForAgentTurn) {
			continuationDispatchedForAgentTurn = false;
			if (!currentPromptSwitch) return;
		}
		if (!config.enabled || !config.autoContinue || userAbortedChain) return;
		await maybeDispatchContinuation(ctx, { recoveryLease });
		} finally {
			flushUsageTelemetry();
			if (continuationRecoveryLease?.token === recoveryLease?.token) {
				continuationRecoveryLease = undefined;
			}
			releaseContextGuardRecovery(recoveryLease);
		}
	});

	// external: Pi awaits the extension factory before restoring the session model.
	return cursorReady;
}
