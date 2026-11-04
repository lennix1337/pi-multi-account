import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("verify runs all local CI validation gates", () => {
	const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(scripts.verify, "npm run check && npm test && npm run mutations && npm run pack:check");
});
