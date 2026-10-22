/**
 * Shape check for `/multi-account` input, run before any subcommand touches discovery, config,
 * auth or routing state. Unknown subcommands and surplus arguments used to fall through to the
 * status path (which refreshes discovery) or be silently ignored, so a typo such as
 * `/multi-account reset now` or `/multi-account log banana` looked like it had worked.
 */

const LOG_MAX_EVENTS = 200;

interface CommandShape {
	/** Subcommand names that route to the same handler. */
	names: readonly string[];
	usage: string;
	/** Tokens after the subcommand; `undefined` means any number. */
	maxArguments?: number;
	/** Extra check on the first argument, for subcommands whose argument has a closed form. */
	acceptsArgument?: (argument: string) => boolean;
}

const NONE = 0;

const COMMAND_SHAPES: readonly CommandShape[] = [
	{ names: ["status"], usage: "/multi-account status", maxArguments: NONE },
	{ names: ["pins"], usage: "/multi-account pins [list]", maxArguments: 1 },
	{
		names: ["pin"],
		usage: "/multi-account pin <provider/model> | unpin <provider-or-family> | pins [list]",
		maxArguments: 1,
	},
	{
		names: ["unpin"],
		usage: "/multi-account pin <provider/model> | unpin <provider-or-family> | pins [list]",
		maxArguments: 1,
	},
	{
		names: ["log", "logs", "debug"],
		usage: `/multi-account log [N|on|off] (N is a whole number from 1 to ${LOG_MAX_EVENTS})`,
		maxArguments: 1,
		acceptsArgument: (argument) => {
			if (argument === "on" || argument === "off") return true;
			if (!/^\d{1,3}$/.test(argument)) return false;
			const count = Number(argument);
			return count >= 1 && count <= LOG_MAX_EVENTS;
		},
	},
	{ names: ["pick"], usage: "/multi-account pick", maxArguments: NONE },
	{ names: ["save-default"], usage: "/multi-account save-default", maxArguments: NONE },
	{ names: ["models", "model"], usage: "/multi-account models", maxArguments: NONE },
	{ names: ["reload"], usage: "/multi-account reload", maxArguments: NONE },
	{ names: ["rediscover"], usage: "/multi-account rediscover", maxArguments: NONE },
	{
		names: ["add"],
		usage: "/multi-account add <anthropic|codex|kimi|cursor|ollama|qwen>",
		maxArguments: 1,
	},
	{
		names: ["remove", "rm", "delete"],
		usage: "/multi-account remove <anthropic|codex|cursor|ollama|qwen|provider-id>",
		maxArguments: 1,
	},
	{ names: ["revive"], usage: "/multi-account revive <provider|all>", maxArguments: 1 },
	{ names: ["clear"], usage: "/multi-account clear", maxArguments: NONE },
	{ names: ["reset"], usage: "/multi-account reset", maxArguments: NONE },
	{ names: ["accounts", "account"], usage: "/multi-account accounts [refresh]", maxArguments: 1 },
	{
		names: ["limits", "usage", "quota"],
		usage: "/multi-account limits [refresh]",
		maxArguments: 1,
		acceptsArgument: (argument) => argument === "refresh",
	},
	{ names: ["switch", "use"], usage: "/multi-account switch <provider>", maxArguments: 1 },
	{ names: ["best", "live"], usage: "/multi-account best", maxArguments: NONE },
	{
		names: ["only-active", "focus"],
		usage: "/multi-account only-active [on|off]",
		maxArguments: 1,
		acceptsArgument: (argument) => argument === "on" || argument === "off",
	},
	{
		names: ["priority", "order"],
		usage: "/multi-account priority [<provider>... | reset | none]",
	},
	{ names: ["next"], usage: "/multi-account next", maxArguments: NONE },
	{ names: ["stop"], usage: "/multi-account stop", maxArguments: NONE },
	{ names: ["enable"], usage: "/multi-account enable", maxArguments: NONE },
	{ names: ["disable"], usage: "/multi-account disable", maxArguments: NONE },
];

const SHAPE_BY_NAME = new Map<string, CommandShape>(
	COMMAND_SHAPES.flatMap((shape) => shape.names.map((name): [string, CommandShape] => [name, shape])),
);

const PRIMARY_NAMES = COMMAND_SHAPES.map((shape) => shape.names[0]).join(", ");

/** Returns the warning to show for malformed `/multi-account` input, or `undefined` when it is well-formed. */
export function commandArgumentsProblem(rawArguments: string): string | undefined {
	const tokens = rawArguments.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return undefined;
	const name = tokens[0].toLowerCase();
	const shape = SHAPE_BY_NAME.get(name);
	if (!shape) {
		const shown = tokens[0].length > 40 ? `${tokens[0].slice(0, 40)}…` : tokens[0];
		return `pi-multi-account: unknown subcommand ${JSON.stringify(shown)}. Nothing was changed. Subcommands: ${PRIMARY_NAMES}. Run /multi-account status for details.`;
	}
	const argumentsGiven = tokens.slice(1);
	const tooMany = shape.maxArguments !== undefined && argumentsGiven.length > shape.maxArguments;
	const rejected = argumentsGiven.length > 0 && shape.acceptsArgument?.(argumentsGiven[0]) === false;
	if (tooMany || rejected) return `pi-multi-account: usage: ${shape.usage}`;
	return undefined;
}
