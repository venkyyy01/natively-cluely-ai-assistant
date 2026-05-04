import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { version } from "./package.json";

// Inject version so the React frontend can read it via import.meta.env.VITE_APP_VERSION
process.env.VITE_APP_VERSION = version;

const stripCrossoriginForElectronFileProtocol = () => ({
	name: "strip-crossorigin-for-electron-file-protocol",
	apply: "build" as const,
	enforce: "post" as const,
	transformIndexHtml(html: string) {
		return html.replace(/\s+crossorigin(?=[\s>])/g, "");
	},
});

// https://vitejs.dev/config/
export default defineConfig({
	plugins: [react(), stripCrossoriginForElectronFileProtocol()],
	base: "./", // Use relative paths for Electron
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	server: {
		port: 5180,
	},
	build: {
		chunkSizeWarningLimit: 1000,
	},
});
