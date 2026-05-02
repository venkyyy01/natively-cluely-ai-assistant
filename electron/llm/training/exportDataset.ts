// electron/llm/training/exportDataset.ts
// Exports the TypeScript intent dataset to JSON for Python training.

import * as fs from "node:fs";
import * as path from "node:path";
import { getAllExamples } from "./intentDataset";

function main() {
	const examples = getAllExamples();
	const output = {
		version: "1.0.0",
		exported_at: new Date().toISOString(),
		count: examples.length,
		examples: examples.map((ex) => ({
			text: ex.text,
			label: ex.label,
			source: ex.source,
			metadata: ex.metadata,
		})),
	};

	const outPath =
		process.argv[2] || path.join(__dirname, "intent_dataset.json");
	fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
	console.log(`[Export] Wrote ${examples.length} examples to ${outPath}`);
}

main();
