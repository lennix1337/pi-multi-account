import assert from "node:assert/strict";
import test from "node:test";
import {
	CONTINUATION_PROMPT,
	actionTextForRebuild,
	requestActionText,
	allPriorTurns,
	historyForRebuild,
	parseMessages,
	renderTurnsAsText,
	systemPromptForRebuild,
	type OpenAIMessage,
} from "../cursor/message-parsing.ts";

const MID_TURN: OpenAIMessage[] = [
	{ role: "system", content: "You are pi." },
	{ role: "user", content: "Порахуй рядки у файлі даних." },
	{
		role: "assistant",
		content: null,
		tool_calls: [
			{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"wc -l data.jsonl"}' } },
		],
	},
	{ role: "tool", tool_call_id: "call_1", content: "17980 data.jsonl" },
];

test("the in-flight turn survives the rebuild instead of being thrown away", () => {
	const parsed = parseMessages(MID_TURN);

	assert.ok(parsed.pendingTurn, "the turn whose tools just returned must be kept");
	assert.equal(parsed.pendingTurn.userText, "Порахуй рядки у файлі даних.");

	const action = requestActionText(parsed, { hasCheckpoint: false });
	const system = systemPromptForRebuild("You are pi.", parsed, { hasCheckpoint: false });

	assert.equal(action, CONTINUATION_PROMPT, "the size-sensitive action must stay short");
	assert.ok(system.includes("Порахуй рядки"), "the user's actual question must reach the model");
	assert.ok(system.includes("wc -l data.jsonl"), "the tool call the assistant already made must reach the model");
	assert.ok(system.includes("17980"), "the tool result must reach the model — this is the work that was lost");
	assert.deepEqual(historyForRebuild(parsed), [], "nothing may be left to the channel that can drop it");
});

test("the rebuild no longer re-asks the original question as if nothing had happened", () => {
	const parsed = parseMessages(MID_TURN);

	const sent = actionTextForRebuild(parsed);
	assert.notEqual(
		sent,
		"Порахуй рядки у файлі даних.",
		"re-asking the question makes the model redo work it already did",
	);
	assert.equal(sent, CONTINUATION_PROMPT, "the ask must be a bounded continuation");
});

test("after compaction the summary is history, not a new user request", () => {
	const summary = "## Goal\n- Поставити на карту 5 530 проспектів\n\n## Next Steps\n1. Залити піни у хмару";
	const afterCompaction: OpenAIMessage[] = [
		{ role: "system", content: "You are pi." },
		{ role: "user", content: `[compaction]\n\n${summary}` },
		{
			role: "assistant",
			content: null,
			tool_calls: [
				{ id: "call_9", type: "function", function: { name: "bash", arguments: '{"command":"ls pins/"}' } },
			],
		},
		{ role: "tool", tool_call_id: "call_9", content: "pins-2026-08-23.jsonl" },
	];

	const parsed = parseMessages(afterCompaction);
	const action = requestActionText(parsed, { hasCheckpoint: false });
	const system = systemPromptForRebuild("You are pi.", parsed, { hasCheckpoint: false });

	assert.ok(system.includes("Поставити на карту"), "the compaction summary must reach the model");
	assert.ok(system.includes("pins-2026-08-23.jsonl"), "the tool result from the interrupted turn must reach it too");
	assert.notEqual(action, `[compaction]\n\n${summary}`, "the summary is not handed over as a new request");
	assert.equal(action, CONTINUATION_PROMPT, "the model must be told to continue, not to start over");
});

test("a plain new question is still just that question", () => {
	const parsed = parseMessages([
		{ role: "system", content: "You are pi." },
		{ role: "user", content: "Перше питання." },
		{ role: "assistant", content: "Перша відповідь." },
		{ role: "user", content: "Друге питання." },
	]);

	assert.equal(parsed.pendingTurn, undefined, "nothing is in flight here");
	const action = requestActionText(parsed, { hasCheckpoint: false });
	const system = systemPromptForRebuild("You are pi.", parsed, { hasCheckpoint: false });
	assert.equal(action, "Друге питання.", "the new question stays the actual ask");
	assert.ok(system.includes("Перше питання."), "and the earlier exchange is restored as context");
	assert.ok(system.includes("Перша відповідь."));
});

test("tool results are still surfaced for the live resume path", () => {
	const parsed = parseMessages(MID_TURN);
	assert.deepEqual(parsed.toolResults, [{ toolCallId: "call_1", content: "17980 data.jsonl" }]);
});

test("a multi-tool turn keeps every call and every result", () => {
	const parsed = parseMessages([
		{ role: "system", content: "s" },
		{ role: "user", content: "Зроби дві речі." },
		{
			role: "assistant",
			content: "Роблю обидві.",
			tool_calls: [
				{ id: "a", type: "function", function: { name: "bash", arguments: '{"command":"one"}' } },
				{ id: "b", type: "function", function: { name: "bash", arguments: '{"command":"two"}' } },
			],
		},
		{ role: "tool", tool_call_id: "a", content: "result-one" },
		{ role: "tool", tool_call_id: "b", content: "result-two" },
	]);

	const sent = systemPromptForRebuild("s", parsed, { hasCheckpoint: false });
	for (const fragment of ["Роблю обидві.", "one", "two", "result-one", "result-two"]) {
		assert.ok(sent.includes(fragment), `${fragment} must survive the rebuild`);
	}
});

test("history and completed turns are never double-counted", () => {
	const parsed = parseMessages(MID_TURN);
	assert.equal(allPriorTurns(parsed).length, parsed.turns.length + 1);
	assert.equal(parsed.turns.length, 0, "allPriorTurns must not mutate what it was handed");
});

test("when Cursor keeps its own history, the tool results travel in the request itself", () => {
	const parsed = parseMessages(MID_TURN);
	const text = requestActionText(parsed, { hasCheckpoint: true });

	assert.ok(text.includes("17980 data.jsonl"), "the results must reach a model that ignores our history");
	assert.ok(text.includes(CONTINUATION_PROMPT), "and they must be framed as a continuation, not a new task");
});

test("when we rebuild the history ourselves, the results are not sent twice", () => {
	const parsed = parseMessages(MID_TURN);
	const action = requestActionText(parsed, { hasCheckpoint: false });
	const system = systemPromptForRebuild("s", parsed, { hasCheckpoint: false });

	assert.equal(action, CONTINUATION_PROMPT, "the ask is still a continuation");
	assert.equal(`${system}\n${action}`.split("17980").length - 1, 1, "the result appears once");
});

test("a plain question is unaffected by who holds the history", () => {
	const parsed = parseMessages([
		{ role: "system", content: "s" },
		{ role: "user", content: "Просте питання." },
	]);
	assert.equal(requestActionText(parsed, { hasCheckpoint: true }), "Просте питання.");
	assert.equal(
		requestActionText(parsed, { hasCheckpoint: false }),
		"Просте питання.",
		"a brand new conversation has nothing to restore, so nothing is wrapped around it",
	);
	assert.equal(
		systemPromptForRebuild("s", parsed, { hasCheckpoint: false }),
		"s",
		"a brand new conversation does not alter the system prompt",
	);
});

test("a checkpoint never duplicates its server-side history into the system prompt", () => {
	const parsed = parseMessages(MID_TURN);
	assert.equal(
		systemPromptForRebuild("You are pi.", parsed, { hasCheckpoint: true }),
		"You are pi.",
	);
});

test("the rendered transcript keeps order, tool arguments and outputs", () => {
	const text = renderTurnsAsText([
		{ userText: "Питання.", steps: [
			{ kind: "assistantText", text: "Думка." },
			{ kind: "toolCall", toolCallId: "t1", toolName: "bash", arguments: { command: "ls" }, result: { content: "out", isError: false } },
			{ kind: "toolCall", toolCallId: "t2", toolName: "read", arguments: { path: "a.ts" }, result: { content: "boom", isError: true } },
		] },
	]);
	assert.ok(text.indexOf("Питання.") < text.indexOf("Думка."), "order must be preserved");
	assert.ok(text.includes('bash({"command":"ls"})'));
	assert.ok(text.includes("result: out"));
	assert.ok(text.includes("error: boom"), "a failed tool must not read as a successful one");
});
