import { randomUUID } from "node:crypto";

export type RecoveryCategory =
	| "policy_refusal"
	| "quota"
	| "context_limit"
	| "transient"
	| "unknown";

export type RecoveryPhase = "started" | "recovering" | "stopped" | "completed";

export interface RecoveryMetadata {
	incidentId: string;
	phase: RecoveryPhase;
	category: RecoveryCategory;
	provider?: string;
	model?: string;
	sessionId?: string;
}

export interface AutomaticRecoveryLease {
	readonly incidentId: string;
	readonly token: symbol;
	markRecovering(
		category?: RecoveryCategory,
		provider?: string,
		model?: string,
	): void;
	release(options?: { complete?: boolean }): void;
}

interface ActiveRecovery {
	token: symbol;
	incidentId: string;
	category: RecoveryCategory;
	provider?: string;
	model?: string;
	sessionId?: string;
	lastTransition: string;
	stopped: boolean;
}

const POLICY_REFUSAL_PATTERNS = [
	/\b(?:content|safety|usage)[ _-]+policy[ _-]+(?:violation|refusal|rejection|blocked|denied)\b/i,
	/\bpolicy violation\b/i,
	/\bviolat(?:e|es|ing) (?:our |the |provider(?:'s )?)?(?:content|safety|usage) polic(?:y|ies)\b/i,
	/\b(?:request|prompt|content) (?:was |has been )?(?:blocked|rejected|refused|denied) (?:as a result of|because of|by|under|due to|for) .{0,80}\b(?:safety|content|moderation|policy)\b/i,
	/\b(?:blocked|rejected|refused|denied) (?:by|under|due to) .{0,80}\b(?:safety|content|moderation|policy)\b/i,
	/\b(?:safety|content|moderation) (?:system|filter|check) .{0,80}\b(?:blocked|rejected|refused|denied)\b/i,
	/\b(?:content|safety)_filter\b/i,
];

/** Detect provider safety refusals, without treating ordinary quota/auth failures as terminal. */
export function isPolicyRefusal(error: unknown): boolean {
	const text =
		error instanceof Error
			? `${error.name}: ${error.message}`
			: typeof error === "string"
				? error
				: error && typeof error === "object" && "message" in error
					? String((error as { message?: unknown }).message ?? "")
					: String(error ?? "");
	return POLICY_REFUSAL_PATTERNS.some((pattern) => pattern.test(text));
}

/** Single-owner arbitration for extension-managed automatic recovery in one session. */
export class AutomaticRecoveryArbiter {
	#active?: ActiveRecovery;
	#policyRefusalStopped = false;
	#emit: (metadata: RecoveryMetadata) => void;
	#createIncidentId: () => string;

	constructor(
		emit: (metadata: RecoveryMetadata) => void,
		createIncidentId: () => string = randomUUID,
	) {
		this.#emit = emit;
		this.#createIncidentId = createIncidentId;
	}

	get policyRefusalStopped(): boolean {
		return this.#policyRefusalStopped;
	}

	tryAcquire(
		metadata: Pick<RecoveryMetadata, "category"> & Partial<Pick<RecoveryMetadata, "provider" | "model" | "sessionId">>,
		parent?: AutomaticRecoveryLease,
	): AutomaticRecoveryLease | undefined {
		if (this.#policyRefusalStopped) return undefined;

		const active = this.#active;
		if (active) {
			if (!parent || parent.token !== active.token) return undefined;
			return this.#lease(active, false);
		}

		const incidentId = this.#createIncidentId();
		const token = Symbol("automatic recovery");
		const next: ActiveRecovery = {
			token,
			incidentId,
			category: metadata.category,
			provider: metadata.provider,
			model: metadata.model,
			sessionId: metadata.sessionId,
			lastTransition: "",
			stopped: false,
		};
		this.#active = next;
		this.#transition(next, "started");
		return this.#lease(next, true);
	}

	stopForPolicyRefusal(
		metadata: Partial<Pick<RecoveryMetadata, "provider" | "model" | "sessionId">> = {},
	): string {
		this.#policyRefusalStopped = true;
		const active = this.#active;
		if (active) {
			active.category = "policy_refusal";
			active.provider = metadata.provider ?? active.provider;
			active.model = metadata.model ?? active.model;
			active.sessionId = metadata.sessionId ?? active.sessionId;
			active.stopped = true;
			this.#transition(active, "stopped");
			return active.incidentId;
		}

		const incidentId = this.#createIncidentId();
		const incident: ActiveRecovery = {
			token: Symbol("policy refusal"),
			incidentId,
			category: "policy_refusal",
			provider: metadata.provider,
			model: metadata.model,
			sessionId: metadata.sessionId,
			lastTransition: "",
			stopped: true,
		};
		this.#transition(incident, "stopped");
		return incidentId;
	}

	resetForUserControl(): void {
		this.#policyRefusalStopped = false;
	}

	#lease(active: ActiveRecovery, owns: boolean): AutomaticRecoveryLease {
		return {
			incidentId: active.incidentId,
			token: active.token,
			markRecovering: (category, provider, model) => {
				if (this.#active !== active || active.stopped) return;
				if (category) active.category = category;
				if (provider) active.provider = provider;
				if (model) active.model = model;
				this.#transition(active, "recovering");
			},
			release: (options) => {
				if (!owns || this.#active !== active) return;
				this.#active = undefined;
				if (!active.stopped && options?.complete !== false)
					this.#transition(active, "completed");
			},
		};
	}

	#transition(active: ActiveRecovery, phase: RecoveryPhase): void {
		const metadata: RecoveryMetadata = {
			incidentId: active.incidentId,
			phase,
			category: active.category,
			...(active.provider ? { provider: active.provider } : {}),
			...(active.model ? { model: active.model } : {}),
			...(active.sessionId ? { sessionId: active.sessionId } : {}),
		};
		const key = JSON.stringify(metadata);
		if (key === active.lastTransition) return;
		active.lastTransition = key;
		try {
			this.#emit(metadata);
		} catch {
			// Observability listeners must not change recovery behavior.
		}
	}
}
