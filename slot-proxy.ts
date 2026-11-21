
/**
 * The `apiKey` published into `models.json` for a proxied slot.
 *
 * Deliberately not a secret and deliberately recognisable: it exists so Pi will admit the
 * provider, and so this proxy can tell "a child we published a route for" from anything else that
 * found the port. It is also the admission token — see {@link admitRequest}.
 */
export const PROXY_PLACEHOLDER_KEY = "pi-multi-account-proxy";

/** Non-secret Anthropic OAuth-shaped marker replaced by the proxy on egress. */
export const ANTHROPIC_PROXY_PLACEHOLDER_KEY = "sk-ant-oat01-pi-multi-account-proxy";

/** Non-secret unsigned Codex placeholder JWT; the proxy replaces its credential and account ID on egress. */
export const PROXY_PLACEHOLDER_JWT = [
	Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64"),
	Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: PROXY_PLACEHOLDER_KEY },
		}),
	).toString("base64"),
	"",
].join(".");

/** Current or legacy published placeholder — none is a real credential. */
export function isPublishedPlaceholder(value: string | undefined): boolean {
	return value === PROXY_PLACEHOLDER_KEY || value === PROXY_PLACEHOLDER_JWT ||
		value === ANTHROPIC_PROXY_PLACEHOLDER_KEY;
}

export type ProxyFamily = "anthropic" | "codex";

/** Return the parent-owned proxy family for a supported slot, or undefined. */
export function proxyFamilyFor(slotId: string): ProxyFamily | undefined {
	if (slotId === "anthropic" || /^anthropic-account-\d+$/.test(slotId)) return "anthropic";
	if (/^openai-codex-account-\d+$/.test(slotId)) return "codex";
	return undefined;
}

/** Numbered slots have no built-in OAuth method; the child-facing credential must be an API key. */
export function needsChildFacingApiKey(slotId: string): boolean {
	return /(?:-account-\d+)$/.test(slotId) && proxyFamilyFor(slotId) !== undefined;
}

/** Where each family's traffic really goes. */
export const UPSTREAM_BASE: Readonly<Record<ProxyFamily, string>> = Object.freeze({
	anthropic: "https://api.anthropic.com",
	codex: "https://chatgpt.com/backend-api",
});

export interface ProxyRoute {
	slotId: string;
	family: ProxyFamily;
}

export interface ProxyCredential {
	type?: string;
	access?: string;
	key?: string;
	accountId?: string;
}

const DROPPED_HEADERS = new Set([
	"authorization",
	"x-api-key",
	"host",
	"content-length",
	"connection",
	"keep-alive",
	"transfer-encoding",
	"te",
	"trailer",
	"upgrade",
	"proxy-authorization",
	"proxy-authenticate",
	"accept-encoding",
]);

/** Parse a slot and upstream path, rejecting invalid paths and traversal. */
export function parseProxyPath(
	rawUrl: string,
): { slotId: string; rest: string } | undefined {
	if (typeof rawUrl !== "string" || !rawUrl.startsWith("/")) return undefined;
	const [pathname] = rawUrl.split("#");
	const separator = pathname.indexOf("/", 1);
	const slotId = decodeURIComponent(
		separator === -1 ? pathname.slice(1) : pathname.slice(1, separator),
	).split("?")[0];
	if (!slotId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slotId)) return undefined;
	const rest = separator === -1 ? "/" : pathname.slice(separator);
	if (rest.includes("..") || rest.includes("%2e%2e") || rest.includes("%2E%2E")) {
		return undefined;
	}
	return { slotId, rest };
}

/** The credential the caller presented, from either header a Pi provider might use. */
export function presentedCredential(
	headers: Readonly<Record<string, string | string[] | undefined>>,
): string | undefined {
	const pick = (name: string) => {
		const value = headers[name];
		const first = Array.isArray(value) ? value[0] : value;
		return typeof first === "string" ? first.trim() : undefined;
	};
	const bearer = pick("authorization");
	if (bearer) return bearer.replace(/^Bearer\s+/i, "").trim();
	return pick("x-api-key");
}

export type Admission =
	| { ok: true; route: ProxyRoute }
	| { ok: false; status: number; message: string };

/** Admit requests for published slots bearing their placeholder or current access token without echoing credentials. */
export function admitRequest(args: {
	rawUrl: string;
	headers: Readonly<Record<string, string | string[] | undefined>>;
	routes: ReadonlyMap<string, ProxyRoute>;
	/** Current access tokens for this slot. Never logged; compared only. */
	acceptedSecrets?: readonly string[];
}): Admission & { rest?: string } {
	const parsed = parseProxyPath(args.rawUrl);
	if (!parsed) return { ok: false, status: 404, message: "not a slot route" };
	const route = args.routes.get(parsed.slotId);
	if (!route) return { ok: false, status: 404, message: "unknown slot" };
	const presented = presentedCredential(args.headers);
	const accepted =
		isPublishedPlaceholder(presented) ||
		(!!presented && !!args.acceptedSecrets?.includes(presented));
	if (!accepted) {
		return { ok: false, status: 401, message: "this route serves published slots only" };
	}
	return { ok: true, route, rest: parsed.rest };
}

export type UpstreamRequest =
	| { ok: true; url: string; headers: Record<string, string> }
	| { ok: false; status: number; message: string };

/**
 * Build the request that actually goes out.
 *
 * The real credential enters here and leaves only in the returned headers — never in a message,
 * because these messages are logged and shown.
 */
export function shapeUpstreamRequest(args: {
	route: ProxyRoute;
	rest: string;
	headers: Readonly<Record<string, string | string[] | undefined>>;
	credential: ProxyCredential | undefined;
}): UpstreamRequest {
	const { route, rest, credential } = args;
	const base = UPSTREAM_BASE[route.family];
	if (!base) return { ok: false, status: 500, message: `no upstream for ${route.family}` };
	if (!credential) {
		return {
			ok: false,
			status: 401,
			message: `no credential held for ${route.slotId} — run /login for that account`,
		};
	}

	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(args.headers)) {
		const lower = name.toLowerCase();
		if (DROPPED_HEADERS.has(lower)) continue;
		const first = Array.isArray(value) ? value.join(", ") : value;
		if (typeof first === "string") headers[lower] = first;
	}

	if (credential.type === "api_key" || (!credential.access && credential.key)) {
		const key = credential.key;
		if (!key) {
			return {
				ok: false,
				status: 401,
				message: `no API key held for ${route.slotId} — run /login for that account`,
			};
		}
		if (route.family === "anthropic") headers["x-api-key"] = key;
		else headers.authorization = `Bearer ${key}`;
	} else {
		if (!credential.access) {
			return {
				ok: false,
				status: 401,
				message: `the credential for ${route.slotId} has no access token — run /login for that account`,
			};
		}
		headers.authorization = `Bearer ${credential.access}`;
		if (route.family === "anthropic") {
			// external: Anthropic requires this beta header for subscription tokens.
			headers["anthropic-beta"] = mergeBeta(headers["anthropic-beta"], "oauth-2025-04-20");
		} else if (route.family === "codex") {
			// external: Pi fills chatgpt-account-id from its placeholder credential.
			if (credential.accountId) headers["chatgpt-account-id"] = credential.accountId;
			else delete headers["chatgpt-account-id"];
			headers.originator = headers.originator ?? "pi";
		}
	}

	// external: Image tools append endpoints directly to the base URL; chat includes /codex.
	const upstreamRest =
		route.family === "codex" && /^\/images\/(?:generations|edits)(?:\?.*)?$/.test(rest)
			? `/codex${rest}`
			: rest;

	return { ok: true, url: `${base}${upstreamRest}`, headers };
}

function mergeBeta(existing: string | undefined, required: string): string {
	if (!existing) return required;
	const parts = existing
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
	if (!parts.includes(required)) parts.push(required);
	return parts.join(",");
}

/** The `apiKey` to publish for a slot of this family. */
export function placeholderKeyFor(family: ProxyFamily): string {
	return family === "codex" ? PROXY_PLACEHOLDER_JWT : ANTHROPIC_PROXY_PLACEHOLDER_KEY;
}

/** Recognize the previous Anthropic publication without mistaking real tokens for placeholders. */
export function isPlaceholderFor(family: ProxyFamily, value: unknown): boolean {
	return value === placeholderKeyFor(family) ||
		(family === "anthropic" && value === PROXY_PLACEHOLDER_KEY);
}

/** The `models.json` route to publish for a slot served by this proxy. */
export function publishedRouteFor(port: number, slotId: string): string {
	return `http://127.0.0.1:${port}/${slotId}`;
}

/** True when this models.json entry is a loopback we published, not a user's own provider. */
export function isOwnLoopbackPublication(
	existing: unknown,
	family: ProxyFamily,
): boolean {
	if (!existing || typeof existing !== "object") return false;
	const rec = existing as Record<string, unknown>;
	return (
		isPlaceholderFor(family, rec.apiKey) &&
		typeof rec.baseUrl === "string" &&
		rec.baseUrl.startsWith("http://127.0.0.1:")
	);
}

/** Return the user-authored model override layer from a provider entry, if present. */
export function preservedModelOverrides(
	existing: unknown,
): Record<string, unknown> | undefined {
	if (!existing || typeof existing !== "object" || Array.isArray(existing)) return undefined;
	const overrides = (existing as Record<string, unknown>).modelOverrides;
	if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return undefined;
	if (Object.keys(overrides).length === 0) return undefined;
	return overrides as Record<string, unknown>;
}

/**
 * Drop loopback publications this proxy wrote. Cursor and user entries stay. A user's
 * modelOverrides remain as a valid built-in-provider overlay after the generated route is gone.
 * Pass slot ids to drop only those; omit to drop every own loopback (a dead port left behind).
 */
export function dropOwnLoopbackPublications(
	providers: Readonly<Record<string, unknown>>,
	slotIds?: readonly string[],
): Record<string, unknown> {
	const next: Record<string, unknown> = { ...providers };
	const ids = slotIds ?? Object.keys(next);
	for (const id of ids) {
		const family = proxyFamilyFor(id);
		if (!family || !isOwnLoopbackPublication(next[id], family)) continue;
		const modelOverrides = preservedModelOverrides(next[id]);
		if (modelOverrides) next[id] = { modelOverrides };
		else delete next[id];
	}
	return next;
}
