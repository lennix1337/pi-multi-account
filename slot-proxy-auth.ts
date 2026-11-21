import {
	CURSOR_PROXY_PLACEHOLDER_KEY,
	isCursorProviderId,
} from "./cursor-bridge.ts";
import {
	needsChildFacingApiKey,
	isPlaceholderFor,
	placeholderKeyFor,
	proxyFamilyFor,
	type ProxyFamily,
} from "./slot-proxy.ts";

export type AuthBlob = {
	type?: string;
	access?: string;
	refresh?: string;
	expires?: number;
	key?: string;
	accountId?: string;
};

/** The non-secret api_key a child must see, or undefined if this slot is not shadowed. */
export function childFacingPlaceholderKey(slotId: string): string | undefined {
	if (isCursorProviderId(slotId)) return CURSOR_PROXY_PLACEHOLDER_KEY;
	if (!needsChildFacingApiKey(slotId)) return undefined;
	const family = proxyFamilyFor(slotId);
	return family ? placeholderKeyFor(family) : undefined;
}

export function needsAuthShadow(slotId: string): boolean {
	return childFacingPlaceholderKey(slotId) !== undefined;
}

export function childFacingAuthEntry(family: ProxyFamily): AuthBlob {
	return { type: "api_key", key: placeholderKeyFor(family) };
}

export function childFacingAuthEntryForSlot(slotId: string): AuthBlob | undefined {
	const key = childFacingPlaceholderKey(slotId);
	return key ? { type: "api_key", key } : undefined;
}

export function isChildFacingPlaceholder(
	entry: AuthBlob | undefined,
	family: ProxyFamily,
): boolean {
	return entry?.type === "api_key" && isPlaceholderFor(family, entry.key);
}

export function isChildFacingPlaceholderForSlot(
	entry: AuthBlob | undefined,
	slotId: string,
): boolean {
	const key = childFacingPlaceholderKey(slotId);
	const family = proxyFamilyFor(slotId);
	return !!key && entry?.type === "api_key" &&
		(family ? isPlaceholderFor(family, entry.key) : entry.key === key);
}

/** What the parent should use for refresh/upstream: sidecar OAuth wins over a child-facing placeholder. */
export function mergeParentAuth(
	auth: Readonly<Record<string, AuthBlob>>,
	sidecar: Readonly<Record<string, AuthBlob>>,
): Record<string, AuthBlob> {
	const out: Record<string, AuthBlob> = { ...auth };
	for (const [slotId, hidden] of Object.entries(sidecar)) {
		if (hidden?.type !== "oauth") continue;
		if (isChildFacingPlaceholderForSlot(out[slotId], slotId)) out[slotId] = hidden;
	}
	return out;
}

export function applyShadowPlan(
	slotId: string,
	auth: Readonly<Record<string, AuthBlob>>,
	sidecar: Readonly<Record<string, AuthBlob>>,
): { auth: Record<string, AuthBlob>; sidecar: Record<string, AuthBlob>; changed: boolean } {
	const facing = childFacingAuthEntryForSlot(slotId);
	if (!facing) {
		return { auth: { ...auth }, sidecar: { ...sidecar }, changed: false };
	}
	const entry = auth[slotId];
	const hidden = sidecar[slotId];
	if (isChildFacingPlaceholderForSlot(entry, slotId) && entry?.key !== facing.key &&
		hidden?.type === "oauth" && typeof hidden.access === "string" && hidden.access.length > 0) {
		return { auth: { ...auth, [slotId]: facing }, sidecar: { ...sidecar }, changed: true };
	}
	if (entry?.type === "oauth" && typeof entry.access === "string" && entry.access.length > 0) {
		return {
			auth: { ...auth, [slotId]: facing },
			sidecar: { ...sidecar, [slotId]: entry },
			changed: true,
		};
	}
	return { auth: { ...auth }, sidecar: { ...sidecar }, changed: false };
}

export function applyRestorePlan(
	slotId: string,
	auth: Readonly<Record<string, AuthBlob>>,
	sidecar: Readonly<Record<string, AuthBlob>>,
): { auth: Record<string, AuthBlob>; sidecar: Record<string, AuthBlob>; changed: boolean } {
	const hidden = sidecar[slotId];
	const nextSidecar = { ...sidecar };
	if (!hidden || hidden.type !== "oauth") {
		return { auth: { ...auth }, sidecar: nextSidecar, changed: false };
	}
	delete nextSidecar[slotId];
	if (isChildFacingPlaceholderForSlot(auth[slotId], slotId)) {
		return {
			auth: { ...auth, [slotId]: hidden },
			sidecar: nextSidecar,
			changed: true,
		};
	}
	return { auth: { ...auth }, sidecar: nextSidecar, changed: true };
}

export function applyShadowAll(
	slotIds: readonly string[],
	auth: Readonly<Record<string, AuthBlob>>,
	sidecar: Readonly<Record<string, AuthBlob>>,
): { auth: Record<string, AuthBlob>; sidecar: Record<string, AuthBlob>; changed: boolean } {
	let nextAuth = { ...auth };
	let nextSidecar = { ...sidecar };
	let changed = false;
	for (const slotId of slotIds) {
		const step = applyShadowPlan(slotId, nextAuth, nextSidecar);
		nextAuth = step.auth;
		nextSidecar = step.sidecar;
		changed = changed || step.changed;
	}
	return { auth: nextAuth, sidecar: nextSidecar, changed };
}

export function applyRestoreAll(
	auth: Readonly<Record<string, AuthBlob>>,
	sidecar: Readonly<Record<string, AuthBlob>>,
): { auth: Record<string, AuthBlob>; sidecar: Record<string, AuthBlob>; changed: boolean } {
	let nextAuth = { ...auth };
	let nextSidecar = { ...sidecar };
	let changed = false;
	for (const slotId of Object.keys(sidecar)) {
		const step = applyRestorePlan(slotId, nextAuth, nextSidecar);
		nextAuth = step.auth;
		nextSidecar = step.sidecar;
		changed = changed || step.changed;
	}
	return { auth: nextAuth, sidecar: nextSidecar, changed };
}
