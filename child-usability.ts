
/** How a slot's credential is stored, as far as `auth.json` is concerned. */
export type SlotCredentialKind = "oauth" | "api_key" | "none";

export interface SlotChildFacts {
  /** Rotation slot id, e.g. `openai-codex-account-4` or a base provider name. */
  slotId: string;
  /** Credential kind held for this exact slot id. */
  credential: SlotCredentialKind;
  /** True when Pi itself defines this provider (it then owns the OAuth flow). */
  builtin: boolean;
  /** `apiKey` published for this slot in `models.json`, when we published one. */
  publishedApiKey?: string;
  /** `baseUrl` published for this slot in `models.json`, when we published one. */
  publishedBaseUrl?: string;
}

export type ChildUsability =
  /** A bare child can authenticate and run on this slot. */
  | { usable: true; slotId: string; via: "builtin" | "api-key" | "parent-proxy"; note: string }
  /** A bare child cannot use it; `remedy` says what would change that. */
  | { usable: false; slotId: string; reason: string; remedy: string };

function vendorRefusesBareChild(
  slotId: string,
  credential: SlotCredentialKind,
  builtin: boolean,
): boolean {
  // external: Pi does not consult OAuth blobs for numbered alias slots.
  return builtin && credential === "oauth" && /^anthropic(?:-account-\d+)?$/.test(slotId);
}

function isLoopback(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  try {
    // external: URL.hostname encloses IPv6 hosts in brackets.
    const hostname = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

/**
 * Decide, for one slot, whether an extension-free child can run on it.
 *
 * Order matters: Pi's resolver keys off the stored credential *type* before it ever looks at a
 * models.json apiKey. An OAuth blob under the same key as a published placeholder is therefore
 * not a usable child route — measured against Pi's own `resolveProviderAuth`: stored OAuth plus a
 * provider that has no OAuth method returns undefined (\"No API key found\"), and stored OAuth
 * plus a built-in OAuth method ignores the placeholder entirely.
 */
export function classifyChildUsability(facts: SlotChildFacts): ChildUsability {
  const { slotId, credential, builtin, publishedApiKey, publishedBaseUrl } = facts;

  const vendorRefuses = vendorRefusesBareChild(slotId, credential, builtin);

  // external: Pi sends stored OAuth credentials instead of a models.json apiKey for built-in providers.
  if (builtin && !vendorRefuses) {
    return {
      usable: true,
      slotId,
      via: "builtin",
      note: "Pi defines this provider itself and owns its auth flow, so a bare child resolves it without this extension.",
    };
  }

  if (vendorRefuses && isLoopback(publishedBaseUrl)) {
    return {
      usable: true,
      slotId,
      via: "parent-proxy",
      note: "The child still presents the subscription token; the published loopback is what makes the parent shape that request instead of the vendor refusing it as a third-party app.",
    };
  }

  if (vendorRefuses) {
    return {
      usable: false,
      slotId,
      reason:
        "The credential is a subscription OAuth token. Pi resolves it, but the vendor then refuses the call as a third-party app (\"Third-party apps now draw from your extra usage, not your plan limits\"), because a bare child does not send the client identity the parent adds.",
      remedy:
        "Publish this account against a parent-owned loopback proxy so the child's request is shaped by the parent that holds the subscription.",
    };
  }

  if (credential === "api_key") {
    if (publishedApiKey && isLoopback(publishedBaseUrl)) {
      return {
        usable: true,
        slotId,
        via: "parent-proxy",
        note: "The child authenticates to a parent-owned loopback route with a non-secret placeholder; the real credential never leaves the parent.",
      };
    }
    return {
      usable: true,
      slotId,
      via: "api-key",
      note: "The credential is an API key, which Pi resolves through its own credential store for a published provider.",
    };
  }

  if (credential === "oauth") {
    return {
      usable: false,
      slotId,
      reason:
        "The credential is OAuth, and Pi honours OAuth only for a provider definition that declares the flow. A models.json entry declares none, so the token under this key is never consulted — even a published placeholder is ignored, and the slot then fails with \"No API key found\".",
      remedy:
        "While the parent proxy is listening, present this slot to a child as a non-secret api_key placeholder and keep the OAuth blob where only the parent reads it.",
    };
  }

  return {
    usable: false,
    slotId,
    reason: "No credential is held for this slot.",
    remedy: "Log in to this account, or drop the slot from the published registry.",
  };
}

/**
 * The slot a bare unpinned child would actually be sent to, given Pi's saved global default.
 * Returns `undefined` when that saved route is usable.
 *
 * This is the check that turns a silent, far-away failure into something sayable here: when the
 * active rotation slot is not child-usable, every child spawned without an explicit `--model`
 * falls through Pi's own "first available provider" list instead — which is a different account,
 * often a different vendor, and never the one the rotation chose.
 */
export function defaultRouteWarning(
  savedDefaultSlotId: string | undefined,
  classify: (slotId: string) => ChildUsability | undefined,
): string | undefined {
  if (!savedDefaultSlotId) return undefined;
  const verdict = classify(savedDefaultSlotId);
  if (!verdict || verdict.usable) return undefined;
  return (
    `Pi's saved global default is ${savedDefaultSlotId}, but a bare extension-free child launched ` +
    `without --model cannot use it: ${verdict.reason} Such an unpinned child falls back to Pi's ` +
    `own first-available provider. The live multi-account session and explicitly pinned ` +
    `broker/subagent children are unaffected. ${verdict.remedy}`
  );
}

/** One line per slot, for `/multi-account status`. Stable order: unusable first, then by id. */
export function describeChildUsability(verdicts: readonly ChildUsability[]): string[] {
  const ordered = [...verdicts].sort(
    (a, b) => Number(a.usable) - Number(b.usable) || a.slotId.localeCompare(b.slotId),
  );
  return ordered.map((verdict) =>
    verdict.usable
      ? `  ${verdict.slotId} — usable by a bare child (${verdict.via})`
      : `  ${verdict.slotId} — NOT usable by a bare child: ${verdict.reason}`,
  );
}
