const { spawn } = require("node:child_process");

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const THRESHOLDS = {
	statements: 90,
	branches: 100,
	functions: 75,
	lines: 90,
};

function parseCoverageSummary(output) {
	const allFilesLine = output
		.split("\n")
		.find((line) => line.includes("All files"));

	if (!allFilesLine) {
		throw new Error("Renderer coverage summary not found in test output.");
	}

	const percentages = [...allFilesLine.matchAll(/(\d+(?:\.\d+)?)/g)].map(
		(match) => Number(match[1]),
	);

	if (percentages.length < 4) {
		throw new Error(
			`Renderer coverage gate failed: could not parse metrics from ${allFilesLine.trim()}`,
		);
	}

	return {
		statements: percentages[0],
		branches: percentages[1],
		functions: percentages[2],
		lines: percentages[3],
	};
}

function evaluateCoverage(summary) {
	const failures = Object.entries(THRESHOLDS)
		.filter(([metric, threshold]) => summary[metric] < threshold)
		.map(
			([metric, threshold]) => `${metric} ${summary[metric]}% < ${threshold}%`,
		);

	return failures.length > 0 ? failures.join(", ") : null;
}

function run(command, args, options = {}) {
	const { timeoutMs = 120000 } = options;
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let output = "";
		let timedOut = false;

		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			reject(
				new Error(
					`Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`,
				),
			);
		}, timeoutMs);

		child.stdout.on("data", (chunk) => {
			const text = chunk.toString();
			output += text;
			process.stdout.write(text);
		});

		child.stderr.on("data", (chunk) => {
			const text = chunk.toString();
			output += text;
			process.stderr.write(text);
		});

		child.on("error", (err) => {
			if (timeout) clearTimeout(timeout);
			if (!timedOut) reject(err);
		});

		child.on("close", (code) => {
			if (timeout) clearTimeout(timeout);
			if (timedOut) return;
			if (code !== 0) {
				reject(new Error(`Command failed: ${command} ${args.join(" ")}`));
				return;
			}

			resolve(output);
		});
	});
}

async function main() {
	console.log(
		"[verify-renderer-coverage] Running renderer tests with coverage...",
	);
	const output = await run(npmCommand, [
		"--prefix",
		"renderer",
		"run",
		"test:coverage",
		"--",
		"--runInBand",
	]);

	let summary;

	try {
		summary = parseCoverageSummary(output);
	} catch (error) {
		console.error(error.message);
		process.exit(1);
	}

	const failureMessage = evaluateCoverage(summary);

	if (failureMessage) {
		console.error(`Renderer coverage gate failed: ${failureMessage}`);
		process.exit(1);
	}

	console.log(
		`Renderer coverage gate passed (statements >= ${THRESHOLDS.statements}%, branches >= ${THRESHOLDS.branches}%, functions >= ${THRESHOLDS.functions}%, lines >= ${THRESHOLDS.lines}%).`,
	);
}

if (require.main === module) {
	main().catch((error) => {
		console.error(error.message);
		process.exit(1);
	});
}

module.exports = {
	THRESHOLDS,
	parseCoverageSummary,
	evaluateCoverage,
};
