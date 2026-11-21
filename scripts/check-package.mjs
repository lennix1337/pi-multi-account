import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { containsPackageSecret } from "../package-secret-scan.ts";

// external: On Windows URL.pathname begins /C:/ and is not a valid filesystem path.
const root = fileURLToPath(new URL("..", import.meta.url));
// external: Node requires shell execution for Windows npm.cmd shims.
const output = JSON.parse(execSync("npm pack --dry-run --json", {
	cwd: root,
	encoding: "utf8",
	stdio: ["ignore", "pipe", "inherit"],
}));
// external: npm through 11 prints a manifest array; npm 12 prints an object keyed by package name.
const packed = Array.isArray(output) ? output : Object.values(output ?? {});
if (packed.length !== 1 || !Array.isArray(packed[0]?.files)) {
	throw new Error("npm pack did not return one package manifest");
}
const names = packed[0].files.map((file) => file.path);
const forbidden = /(^|\/)(?:test|tests|scripts|\.github|node_modules|evidence|patches)(?:\/|$)|(?:^|\/)(?:auth\.json|.*\.sqlite(?:-wal|-shm)?|.*\.sock|.*\.log|.*\.tgz)$/i;
const leaked = names.filter((name) => forbidden.test(name));
if (leaked.length) throw new Error(`Refusing non-public package artifacts: ${leaked.join(", ")}`);
for (const required of ["package.json", "README.md", "CHANGELOG.md", "LICENSE", "SECURITY.md", "index.ts"]) {
	if (!names.includes(required)) throw new Error(`npm package is missing ${required}`);
}
if (!Number.isSafeInteger(packed[0].unpackedSize) || packed[0].unpackedSize > 2 * 1024 * 1024) {
	throw new Error(`npm package is unexpectedly large: ${packed[0].unpackedSize}`);
}
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// external: Pi binds SDK imports to the running host.
for (const name of ["pi-ai", "pi-agent-core", "pi-coding-agent", "pi-tui"]) {
	if (manifest.dependencies?.[`@earendil-works/${name}`]) {
		throw new Error(`${name} must not be an extension runtime dependency`);
	}
}
const supportedPi = ">=0.85.1 <0.88.0 || >=0.99.0 <0.100.0 || >=1.0.0 <2.0.0";
for (const name of ["pi-ai", "pi-coding-agent"]) {
	if (manifest.peerDependencies?.[`@earendil-works/${name}`] !== supportedPi) {
		throw new Error(`${name} must declare the tested Pi host compatibility range`);
	}
}
const declaredVersion = /^const VERSION = "([^"]+)";$/m.exec(
	readFileSync(join(root, "index.ts"), "utf8"),
)?.[1];
if (!declaredVersion) {
	throw new Error(
		'index.ts no longer declares `const VERSION = "…";` — the release version check cannot run',
	);
}
if (declaredVersion !== manifest.version) {
	throw new Error(
		`VERSION mismatch: index.ts says ${declaredVersion}, package.json says ${manifest.version}`,
	);
}
const personalPatterns = [
	/@gmail\.com/i,
	new RegExp(["vitalij", "simko"].join(""), "i"),
	new RegExp(["jrnl", "drive"].join(""), "i"),
	/\/Users\/(?!example|runner|shared)[A-Za-z]/,
];
for (const name of names) {
	const text = readFileSync(join(root, name), "utf8");
	if (containsPackageSecret(text)) {
		throw new Error(`Potential secret marker in publishable file: ${name}`);
	}
	if (personalPatterns.some((pattern) => pattern.test(text))) {
		throw new Error(`Personal identifier in publishable file: ${name}`);
	}
}
console.log(`package check: pass (${names.length} files, ${packed[0].unpackedSize} bytes unpacked)`);
