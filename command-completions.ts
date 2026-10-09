/**
 * Argument completions for `/multi-account`: the subcommand first, then the account for
 * `use`/`switch`. Typing an exact provider id from memory was the only way to reach a chosen
 * account, so the list shows every account with what the accounts table knows about it, ready
 * ones first.
 */

/** Same shape as Pi's `AutocompleteItem`; declared here so the module stays free of host imports. */
export interface CompletionItem {
	value: string;
	label: string;
	description?: string;
}

export interface AccountChoice {
	provider: string;
	/** Status as the accounts table shows it, e.g. `ready` or `cooldown 2h 10m`. */
	status: string;
	ready: boolean;
	current: boolean;
	/** Account identity the provider reports (usually an email). */
	account?: string;
	/** Primary usage window, e.g. `5h 80%/2h`. */
	usage?: string;
}

const SUBCOMMANDS: ReadonlyArray<readonly [name: string, description: string]> = [
	["use", "Switch to an account"],
	["switch", "Switch to an account (same as use)"],
	["best", "Jump to an account that can work now"],
	["next", "Step to the next account, ready ones first"],
	["status", "Current account, rotation and settings"],
	["accounts", "Every account with its usage and status"],
	["limits", "Usage limits of the current account"],
	["models", "Model order per account"],
	["pick", "Pick a model of the current account"],
	["priority", "Show or change the failover provider order"],
	["pin", "Prefer a model for an account group"],
	["unpin", "Remove a model pin"],
	["pins", "List model pins"],
	["save-default", "Keep the current model and thinking for new sessions"],
	["log", "Show the failover decision log"],
	["only-active", "Toggle the current-account-only model list"],
	["rediscover", "Re-read accounts and refresh their metadata"],
	["add", "Log in another account"],
	["remove", "Remove an account"],
	["revive", "Put an account marked for re-login back in rotation"],
	["clear", "Wipe all failover state and numbered account logins"],
	["stop", "Stop automatic failover and resume for this task"],
	["reset", "Reset cooldowns, invalidations and pending resume"],
	["reload", "Reload config and re-discover accounts"],
	["enable", "Turn failover on for this Pi process"],
	["disable", "Turn failover off for this Pi process"],
];

const ACCOUNT_COMMANDS = new Set(["use", "switch"]);

export function multiAccountCompletions(
	argumentPrefix: string,
	listAccounts: () => AccountChoice[],
): CompletionItem[] | null {
	const [commandRaw = "", target, ...rest] = argumentPrefix.trimStart().split(/\s+/);
	const command = commandRaw.toLowerCase();
	if (target === undefined) {
		const items = SUBCOMMANDS.filter(([name]) => name.startsWith(command)).map(
			([name, description]) => ({ value: `${name} `, label: name, description }),
		);
		return items.length > 0 ? items : null;
	}
	if (rest.length > 0 || !ACCOUNT_COMMANDS.has(command)) return null;

	const needle = target.toLowerCase();
	const rank = (choice: AccountChoice) => (choice.current ? 2 : choice.ready ? 0 : 1);
	const items = listAccounts()
		.filter(
			(choice) =>
				choice.provider.toLowerCase().includes(needle) ||
				choice.account?.toLowerCase().includes(needle),
		)
		// Stable sort: within a rank the rotation order is kept.
		.sort((left, right) => rank(left) - rank(right))
		.map((choice) => ({
			value: `${command} ${choice.provider}`,
			label: choice.provider,
			description: [
				choice.account,
				choice.current ? `current · ${choice.status}` : choice.status,
				choice.usage,
			]
				.filter(Boolean)
				.join(" · "),
		}));
	return items.length > 0 ? items : null;
}
