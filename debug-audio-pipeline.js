#!/usr/bin/env node

/**
 * Audio Pipeline Debug Script
 *
 * Run this script to check the entire audio → transcription → LLM pipeline
 * Usage: node debug-audio-pipeline.js
 */

const fs = require("node:fs");
const path = require("node:path");

console.log("🔍 AUDIO PIPELINE DIAGNOSTIC\n");

// Check 1: Native Module
console.log("1️⃣ NATIVE MODULE CHECK:");
try {
	const nativeModulePath = path.join(__dirname, "native-module");
	if (!fs.existsSync(nativeModulePath)) {
		console.log("❌ native-module directory missing");
		process.exit(1);
	}

	const indexPath = path.join(nativeModulePath, "index.js");
	const binPath = path.join(nativeModulePath, "index.darwin-arm64.node");

	console.log(`✅ native-module directory exists`);
	console.log(`${fs.existsSync(indexPath) ? "✅" : "❌"} index.js exists`);
	console.log(
		`${fs.existsSync(binPath) ? "✅" : "❌"} binary exists (${binPath})`,
	);

	if (fs.existsSync(binPath)) {
		const stats = fs.statSync(binPath);
		console.log(`📊 Binary size: ${Math.round(stats.size / 1024)}KB`);
	}

	// Try to load the module
	try {
		const nativeModule = require("./native-module");
		console.log("✅ Native module loads successfully");
		console.log("📋 Exports:", Object.keys(nativeModule));
		console.log(
			`${typeof nativeModule.MicrophoneCapture === "function" ? "✅" : "❌"} MicrophoneCapture constructor available`,
		);
	} catch (loadError) {
		console.log("❌ Native module load failed:", loadError.message);
	}
} catch (error) {
	console.log("❌ Native module check failed:", error.message);
}

console.log("\n2️⃣ ELECTRON AUDIO SETUP CHECK:");
const electronFiles = [
	"electron/audio/nativeModule.ts",
	"electron/audio/MicrophoneCapture.ts",
	"electron/audio/DeepgramStreamingSTT.ts",
	"electron/audio/SystemAudioCapture.ts",
	"electron/main.ts",
];

electronFiles.forEach((file) => {
	const exists = fs.existsSync(path.join(__dirname, file));
	console.log(`${exists ? "✅" : "❌"} ${file}`);
});

console.log("\n3️⃣ INTELLIGENCE PIPELINE CHECK:");
const intelligenceFiles = [
	"electron/IntelligenceEngine.ts",
	"electron/IntelligenceManager.ts",
	"electron/ConsciousMode.ts",
	"electron/llm/index.ts",
];

intelligenceFiles.forEach((file) => {
	const exists = fs.existsSync(path.join(__dirname, file));
	console.log(`${exists ? "✅" : "❌"} ${file}`);
});

console.log("\n4️⃣ UI COMPONENTS CHECK:");
const uiFiles = ["src/components/NativelyInterface.tsx", "electron/preload.ts"];

uiFiles.forEach((file) => {
	const exists = fs.existsSync(path.join(__dirname, file));
	console.log(`${exists ? "✅" : "❌"} ${file}`);
});

console.log("\n🔧 RECOMMENDED DEBUGGING STEPS:\n");
console.log("Phase 1 - Native Module:");
console.log("• npm run build:native:current");
console.log('• Check Console for "[NativeAudio]" logs');
console.log("• Verify microphone permissions (macOS)");

console.log("\nPhase 2 - Audio Flow:");
console.log('• Start recording and check for "🎤 Audio chunk" logs');
console.log("• Verify STT provider status in Console");
console.log("• Check WebSocket connections for streaming providers");

console.log("\nPhase 3 - Transcript Flow:");
console.log('• Look for "📝 TRANSCRIPT" logs in Console');
console.log("• Verify meeting state is active");
console.log("• Check IPC message delivery to UI");

console.log("\nPhase 4 - Auto-Trigger:");
console.log('• Monitor "🔍 AUTO-TRIGGER" logs');
console.log("• Verify speaker=interviewer and final=true");
console.log("• Check Intelligence Engine mode and cooldown");

console.log("\n🚀 TO START DEBUGGING:");
console.log("1. Open Electron DevTools (View → Toggle Developer Tools)");
console.log("2. Start a meeting and speak");
console.log("3. Watch Console for logs with emojis (🎤📝🤖✅❌)");
console.log("4. Follow the diagnostic output to identify failure points");

console.log("\n✅ Pipeline diagnostic complete!");
