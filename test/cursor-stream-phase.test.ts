import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { createStreamPhase, type StreamPhase } from "../cursor/stream-phase.ts";

test("a stream follows the documented phases", () => {
	const phase = createStreamPhase({ strict: true });
	assert.equal(phase.current, "streaming");
	assert.equal(phase.move("tools_queued"), true);
	assert.equal(phase.move("tools_paused"), true);
	assert.equal(phase.current, "tools_paused");
});

test("terminal phases accept no further transition", () => {
	const terminals: StreamPhase[] = ["tools_paused", "finished", "cancelled"];
	const targets: StreamPhase[] = ["streaming", "tools_queued", "tools_paused", "finished", "cancelled"];
	for (const terminal of terminals) {
		for (const target of targets) {
			const phase = createStreamPhase({ strict: true });
			if (terminal === "tools_paused") {
				phase.move("tools_queued");
			}
			phase.move(terminal);
			assert.throws(() => phase.move(target), /illegal Cursor stream transition/, `${terminal} -> ${target}`);
		}
	}
});

test("a tool cannot pause the stream before it was queued", () => {
	const phase = createStreamPhase({ strict: true });
	assert.throws(() => phase.move("tools_paused"), /streaming -> tools_paused/);
});

test("outside tests an illegal transition is ignored and reported once", () => {
	const reports: string[] = [];
	const phase = createStreamPhase({ strict: false, onIllegal: (from, to) => reports.push(`${from}->${to}`) });
	phase.move("cancelled");
	assert.equal(phase.move("finished"), false);
	assert.equal(phase.move("tools_queued"), false);
	assert.equal(phase.current, "cancelled");
	assert.deepEqual(reports, ["cancelled->finished"]);
});

// A paused Run keeps its bridge in the registry so Pi's tool results can resume it. If that bridge
// dies while Pi is still running the tools, nothing can ever resume it.
test("a bridge that dies while the stream is paused for tools leaves no registry entry behind", () => {
	const output = execFileSync(
		process.execPath,
		[
			"--import",
			new URL("./fixtures/typescript-loader.mjs", import.meta.url).href,
			"--input-type=module",
			"-e",
			`
		import assert from "node:assert/strict";
		import { EventEmitter } from "node:events";
		import { mock } from "node:test";
		import { create, toBinary } from "@bufbuild/protobuf";
		import { AgentServerMessageSchema } from "./cursor/proto/agent_pb.ts";
		import { writeSSEStreamForTests, __testInternals } from "./cursor/proxy.ts";
		mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		mock.method(performance, "now", () => Date.now());
		process.env.PI_CURSOR_TOOL_COALESCE_MS = "20";

		function frame(message) {
			const body = toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, { message }));
			const bytes = Buffer.alloc(5 + body.length); bytes.writeUInt32BE(body.length, 1); bytes.set(body, 5); return bytes;
		}
		let output = "";
		const res = Object.assign(new EventEmitter(), {
			writableEnded: false, destroyed: false,
			writeHead() {}, flushHeaders() {}, write(data) { output += data; },
			end() { this.writableEnded = true; this.emit("close"); },
		});
		let receive;
		let closed;
		const bridge = {
			alive: true, proc: { kill() {} },
			write() {}, end() { this.alive = false; }, destroy() { this.alive = false; },
			onData(cb) { receive = cb; }, onClose(cb) { closed = cb; },
		};
		try {
			writeSSEStreamForTests({
				bridge, heartbeatTimer: setInterval(() => {}, 5000),
				mcpTools: [{ name: "bash", toolName: "bash" }],
				modelId: "fixture", bridgeKey: "paused-bridge", convKey: "paused-bridge", completedTurns: [],
				currentTurn: { userText: "run", steps: [] }, req: new EventEmitter(), res,
			});
			receive(frame({ case: "execServerMessage", value: {
				id: 3, execId: "exec-3", message: { case: "shellArgs", value: {
					command: "true", workingDirectory: "/tmp", toolCallId: "tool-3",
				} },
			} }));
			mock.timers.tick(20);
			assert.match(output, /"finish_reason":"tool_calls"/);
			assert.ok(__testInternals.activeBridges.get("paused-bridge"), "the paused Run waits for Pi's tool results");

			bridge.alive = false;
			closed(1);
			assert.equal(
				__testInternals.activeBridges.has("paused-bridge"),
				false,
				"a paused Run whose bridge died must not stay registered as resumable",
			);
			console.log("PAUSED_BRIDGE_DROPPED");
		} finally { mock.timers.reset(); }
	`,
		],
		{ cwd: new URL("../", import.meta.url), encoding: "utf8", stdio: "pipe" },
	);
	assert.match(output, /PAUSED_BRIDGE_DROPPED/);
});
