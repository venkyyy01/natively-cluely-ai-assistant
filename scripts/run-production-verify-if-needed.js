const { spawnSync } = require("node:child_process");

if (process.env.SKIP_PRODUCTION_VERIFY === "1") {
	console.log("Skipping production verification gate.");
	process.exit(0);
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npmCommand, ["run", "verify:production"], {
	stdio: "inherit",
});

process.exit(result.status ?? 1);
