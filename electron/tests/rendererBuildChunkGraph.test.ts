import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(__dirname, "../../..");
const distDir = path.join(repoRoot, "dist");

const getJavaScriptChunkImports = (filePath: string): string[] => {
	const source = fs.readFileSync(filePath, "utf8");
	const matches = source.matchAll(
		/import(?:[^'";]*from\s*)?["'](\.\/[^"']+\.js)["']/g,
	);
	return [...new Set(Array.from(matches, (match) => match[1]))];
};

test("production renderer build does not emit circular entry chunk imports", () => {
	execFileSync("npx", ["vite", "build"], {
		cwd: repoRoot,
		stdio: "ignore",
	});

	const indexHtml = fs.readFileSync(path.join(distDir, "index.html"), "utf8");
	const referencedChunks = Array.from(
		indexHtml.matchAll(/(?:src|href)="(\.\/assets\/[^"']+\.js)"/g),
		(match) => match[1],
	);

	assert.ok(
		referencedChunks.length > 0,
		"expected index.html to reference built JavaScript chunks",
	);

	const importGraph = new Map<string, string[]>();
	for (const relativeChunkPath of referencedChunks) {
		const normalizedChunkPath = relativeChunkPath.replace(/^\.\//, "");
		const absoluteChunkPath = path.join(distDir, normalizedChunkPath);
		const normalizedImports = getJavaScriptChunkImports(absoluteChunkPath).map(
			(importPath) =>
				path.posix.normalize(
					path.posix.join(
						path.posix.dirname(normalizedChunkPath),
						importPath.replace(/^\.\//, ""),
					),
				),
		);
		importGraph.set(normalizedChunkPath, normalizedImports);
	}

	const circularPairs: string[] = [];
	for (const [chunkPath, imports] of importGraph.entries()) {
		for (const importedPath of imports) {
			const importedChunkImports = importGraph.get(importedPath);
			if (importedChunkImports?.includes(chunkPath)) {
				circularPairs.push(`${chunkPath} <-> ${importedPath}`);
			}
		}
	}

	assert.deepEqual(
		circularPairs,
		[],
		`expected build entry chunks to be acyclic, got ${circularPairs.join(", ")}`,
	);
});
