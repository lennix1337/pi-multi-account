/**
 * Where one Cursor Run stands while it is being written to a single OpenAI SSE response.
 *
 * The writer used to keep this as three booleans (`cancelled`, `mcpExecReceived`,
 * `toolCallsFlushed`) that every handler combined by hand. Not every combination meant
 * something, and nothing stopped a handler from acting on one that did not — for example
 * queueing a tool after the stream had already paused for it. One phase with an explicit
 * transition table makes those combinations unrepresentable.
 *
 *   streaming ──tool arrives──▶ tools_queued ──coalesce window ends──▶ tools_paused
 *       │                            │
 *       ├──turn ends / error──▶ finished ◀──bridge closed before tools could run
 *       └──client gone / stall──▶ cancelled ◀──client gone / stall
 *
 * `tools_paused`, `finished` and `cancelled` are terminal for this writer. A paused Run is
 * continued by a NEW writer when Pi returns the tool results.
 */
export type StreamPhase = "streaming" | "tools_queued" | "tools_paused" | "finished" | "cancelled";

const LEGAL_TRANSITIONS: Readonly<Record<StreamPhase, readonly StreamPhase[]>> = {
	streaming: ["tools_queued", "finished", "cancelled"],
	tools_queued: ["tools_paused", "finished", "cancelled"],
	tools_paused: [],
	finished: [],
	cancelled: [],
};

export interface StreamPhaseMachine {
	readonly current: StreamPhase;
	is(...phases: StreamPhase[]): boolean;
	/**
	 * Move to `next`. An illegal move leaves the phase unchanged and returns false; when
	 * `strict`, it throws instead so tests cannot miss it. Outside tests a throw would only
	 * surface inside a socket callback, so the first illegal move is reported once through
	 * `onIllegal` and the rest are ignored.
	 */
	move(next: StreamPhase): boolean;
}

export function createStreamPhase(options: {
	strict: boolean;
	onIllegal?: (from: StreamPhase, to: StreamPhase) => void;
}): StreamPhaseMachine {
	let current: StreamPhase = "streaming";
	let reported = false;
	return {
		get current() {
			return current;
		},
		is: (...phases) => phases.includes(current),
		move(next) {
			if (!LEGAL_TRANSITIONS[current].includes(next)) {
				if (options.strict) throw new Error(`illegal Cursor stream transition ${current} -> ${next}`);
				if (!reported) {
					reported = true;
					options.onIllegal?.(current, next);
				}
				return false;
			}
			current = next;
			return true;
		},
	};
}
