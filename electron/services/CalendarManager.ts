import axios from "axios";
import crypto from "crypto";
import { app, safeStorage, shell } from "electron";
import { EventEmitter } from "events";
import fs from "fs";
import http from "http";
import path from "path";
import url from "url";

// Configuration
// In a real app, these should be in environment variables or build configs
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "YOUR_CLIENT_ID_HERE";
const GOOGLE_CLIENT_SECRET =
	process.env.GOOGLE_CLIENT_SECRET || "YOUR_CLIENT_SECRET_HERE";
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PORT = 0;
const CALLBACK_PATH = "/auth/callback";
const AUTH_FLOW_TIMEOUT_MS = 120000;
const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];
const TOKEN_PATH = path.join(app.getPath("userData"), "calendar_tokens.enc");

if (
	GOOGLE_CLIENT_ID === "YOUR_CLIENT_ID_HERE" ||
	GOOGLE_CLIENT_SECRET === "YOUR_CLIENT_SECRET_HERE"
) {
	console.warn(
		"[CalendarManager] Google OAuth credentials are using defaults. Calendar features will not work until valid credentials are provided via env vars.",
	);
}

export interface CalendarEvent {
	id: string;
	title: string;
	startTime: string; // ISO
	endTime: string; // ISO
	link?: string;
	source: "google";
}

export class CalendarManager extends EventEmitter {
	private static instance: CalendarManager;
	private accessToken: string | null = null;
	private refreshToken: string | null = null;
	private expiryDate: number | null = null;
	private isConnected: boolean = false;
	private updateInterval: NodeJS.Timeout | null = null;
	private pendingOauthState: string | null = null;

	private createPkcePair(): { verifier: string; challenge: string } {
		const verifier = crypto.randomBytes(48).toString("base64url");
		const challenge = crypto
			.createHash("sha256")
			.update(verifier)
			.digest("base64url");
		return { verifier, challenge };
	}

	private isLoopbackRequest(req: http.IncomingMessage): boolean {
		const remoteAddress = req.socket.remoteAddress;
		return (
			remoteAddress === "127.0.0.1" ||
			remoteAddress === "::1" ||
			remoteAddress === "::ffff:127.0.0.1"
		);
	}

	private getRedirectUri(server: http.Server): string {
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error(
				"OAuth loopback listener did not expose a usable address",
			);
		}

		return `http://${CALLBACK_HOST}:${address.port}${CALLBACK_PATH}`;
	}

	private constructor() {
		super();
		// Tokens loaded in init() to ensure safeStorage is ready
	}

	public static getInstance(): CalendarManager {
		if (!CalendarManager.instance) {
			CalendarManager.instance = new CalendarManager();
		}
		return CalendarManager.instance;
	}

	public init() {
		this.loadTokens();
	}

	// =========================================================================
	// Auth Flow
	// =========================================================================

	public async startAuthFlow(): Promise<void> {
		if (
			GOOGLE_CLIENT_ID === "YOUR_CLIENT_ID_HERE" ||
			GOOGLE_CLIENT_SECRET === "YOUR_CLIENT_SECRET_HERE"
		) {
			throw new Error(
				"Google Calendar is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET before connecting.",
			);
		}

		if (this.pendingOauthState) {
			throw new Error("Google Calendar authentication is already in progress.");
		}

		const expectedState = crypto.randomBytes(24).toString("hex");
		const { verifier, challenge } = this.createPkcePair();
		this.pendingOauthState = expectedState;

		return new Promise((resolve, reject) => {
			let settled = false;

			const finish = (server: http.Server, callback: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				this.pendingOauthState = null;
				server.close(() => callback());
			};

			// 1. Create Loopback Server
			const server = http.createServer(async (req, res) => {
				try {
					const redirectUri = this.getRedirectUri(server);
					const parsedUrl = new url.URL(req.url || "/", redirectUri);
					if (parsedUrl.pathname !== CALLBACK_PATH) {
						res.statusCode = 404;
						res.end("Not found.");
						return;
					}

					if (req.method !== "GET" || !this.isLoopbackRequest(req)) {
						res.statusCode = 400;
						res.end("Authentication request rejected.");
						finish(server, () =>
							reject(new Error("Rejected non-loopback OAuth callback")),
						);
						return;
					}

					const code = parsedUrl.searchParams.get("code");
					const error = parsedUrl.searchParams.get("error");
					const state = parsedUrl.searchParams.get("state");

					if (error) {
						res.end("Authentication failed! You can close this window.");
						finish(server, () => reject(new Error(error)));
						return;
					}

					if (
						!state ||
						state !== expectedState ||
						this.pendingOauthState !== state
					) {
						res.end(
							"Authentication failed due to invalid session state. You can close this window.",
						);
						finish(server, () => reject(new Error("OAuth state mismatch")));
						return;
					}

					if (!code) {
						res.end(
							"Authentication failed because no authorization code was returned.",
						);
						finish(server, () =>
							reject(new Error("OAuth callback missing authorization code")),
						);
						return;
					}

					res.end(
						"Authentication successful! You can close this window and return to Natively.",
					);
					finish(server, async () => {
						try {
							await this.exchangeCodeForToken(code, verifier, redirectUri);
							resolve();
						} catch (err) {
							reject(err);
						}
					});
				} catch (err) {
					res.end("Authentication error.");
					finish(server, () => reject(err));
				}
			});

			const timeout = setTimeout(() => {
				finish(server, () =>
					reject(new Error("Google Calendar authentication timed out")),
				);
			}, AUTH_FLOW_TIMEOUT_MS);

			server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
				try {
					const authUrl = this.getAuthUrl(
						expectedState,
						challenge,
						this.getRedirectUri(server),
					);
					void Promise.resolve(shell.openExternal(authUrl)).catch(
						(err: unknown) => {
							finish(server, () => reject(err));
						},
					);
				} catch (err) {
					finish(server, () => reject(err));
				}
			});

			server.on("error", (err) => {
				finish(server, () => reject(err));
			});
		});
	}

	public async disconnect(): Promise<void> {
		this.accessToken = null;
		this.refreshToken = null;
		this.expiryDate = null;
		this.isConnected = false;

		if (fs.existsSync(TOKEN_PATH)) {
			fs.unlinkSync(TOKEN_PATH);
		}

		this.emit("connection-changed", false);
	}

	public getConnectionStatus(): {
		connected: boolean;
		email?: string;
		lastSync?: number;
	} {
		// We don't store email in tokens usually, but we could fetch it.
		// For now, simpler boolean.
		return { connected: this.isConnected };
	}

	private getAuthUrl(
		state: string,
		codeChallenge: string,
		redirectUri: string,
	): string {
		const params = new URLSearchParams({
			client_id: GOOGLE_CLIENT_ID,
			redirect_uri: redirectUri,
			response_type: "code",
			scope: SCOPES.join(" "),
			access_type: "offline", // For refresh token
			prompt: "consent", // Force prompts to ensure we get refresh token
			state,
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
		});
		return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
	}

	private async exchangeCodeForToken(
		code: string,
		codeVerifier: string,
		redirectUri: string,
	) {
		try {
			const response = await axios.post("https://oauth2.googleapis.com/token", {
				code,
				client_id: GOOGLE_CLIENT_ID,
				client_secret: GOOGLE_CLIENT_SECRET,
				redirect_uri: redirectUri,
				grant_type: "authorization_code",
				code_verifier: codeVerifier,
			});

			this.handleTokenResponse(response.data);
		} catch (error) {
			console.error("[CalendarManager] Token exchange failed:", error);
			throw error;
		}
	}

	// =========================================================================
	// Refresh Logic (NEW)
	// =========================================================================

	public async refreshState(): Promise<void> {
		console.log(
			"[CalendarManager] Refreshing state (Reality Reconciliation)...",
		);

		// 1. Reset Soft Heuristics
		// Clear existing reminder timeouts to prevent double scheduling or stale alerts
		this.reminderTimeouts.forEach((t) => clearTimeout(t));
		this.reminderTimeouts = [];

		// 2. Calendar Re-sync & Temporal Re-evaluation
		if (this.isConnected) {
			// Force fetch will also re-schedule reminders based on NEW time
			await this.getUpcomingEvents(true);
		} else {
			console.log("[CalendarManager] Calendar not connected, skipping fetch.");
		}

		// 3. Emit update to UI
		// We emit 'updated' so the frontend knows to re-fetch via getUpcomingEvents
		// or we could push the data. usually ipcHandlers just call getUpcomingEvents.
		this.emit("events-updated");
	}

	private handleTokenResponse(data: any) {
		this.accessToken = data.access_token;
		if (data.refresh_token) {
			this.refreshToken = data.refresh_token; // Only returned on first consent
		}
		this.expiryDate = Date.now() + data.expires_in * 1000;
		this.isConnected = true;
		this.saveTokens();
		this.emit("connection-changed", true);

		// Initial fetch
		this.fetchUpcomingEvents();
	}

	private async refreshAccessToken() {
		if (!this.refreshToken) {
			throw new Error("No refresh token available");
		}

		try {
			const response = await axios.post("https://oauth2.googleapis.com/token", {
				client_id: GOOGLE_CLIENT_ID,
				client_secret: GOOGLE_CLIENT_SECRET,
				refresh_token: this.refreshToken,
				grant_type: "refresh_token",
			});

			this.handleTokenResponse(response.data);
		} catch (error) {
			console.error("[CalendarManager] Token refresh failed:", error);
			// If refresh fails (e.g. revoked), disconnect
			this.disconnect();
		}
	}

	// =========================================================================
	// Token Storage (Encrypted)
	// =========================================================================

	private saveTokens() {
		if (!safeStorage.isEncryptionAvailable()) {
			console.warn(
				"[CalendarManager] Encryption not available, skipping token save",
			);
			return;
		}

		const data = JSON.stringify({
			accessToken: this.accessToken,
			refreshToken: this.refreshToken,
			expiryDate: this.expiryDate,
		});

		const encrypted = safeStorage.encryptString(data);
		const tmpPath = TOKEN_PATH + ".tmp";
		fs.writeFileSync(tmpPath, encrypted);
		fs.renameSync(tmpPath, TOKEN_PATH);
	}

	private loadTokens() {
		if (!fs.existsSync(TOKEN_PATH)) return;

		try {
			if (!safeStorage.isEncryptionAvailable()) return;

			const encrypted = fs.readFileSync(TOKEN_PATH);
			const decrypted = safeStorage.decryptString(encrypted);
			const data = JSON.parse(decrypted);

			this.accessToken = data.accessToken;
			this.refreshToken = data.refreshToken;
			this.expiryDate = data.expiryDate;

			if (this.accessToken && this.refreshToken) {
				this.isConnected = true;
				// Check expiry
				if (this.expiryDate && Date.now() >= this.expiryDate) {
					this.refreshAccessToken();
				}
			}
		} catch (error) {
			console.error("[CalendarManager] Failed to load tokens:", error);
		}
	}

	// =========================================================================
	// Reminders
	// =========================================================================

	private reminderTimeouts: NodeJS.Timeout[] = [];

	private scheduleReminders(events: CalendarEvent[]) {
		// Clear existing
		this.reminderTimeouts.forEach((t) => clearTimeout(t));
		this.reminderTimeouts = [];

		const now = Date.now();

		events.forEach((event) => {
			const startStr = event.startTime;
			if (!startStr) return;

			const startTime = new Date(startStr).getTime();
			// Reminder time: 2 minutes before
			const reminderTime = startTime - 2 * 60 * 1000;

			if (reminderTime > now) {
				const delay = reminderTime - now;
				// Only schedule if within next 24h (which fetch already limits)
				if (delay < 24 * 60 * 60 * 1000) {
					const timeout = setTimeout(() => {
						this.showNotification(event);
					}, delay);
					this.reminderTimeouts.push(timeout);
				}
			}
		});
	}

	private showNotification(event: CalendarEvent) {
		const { Notification } = require("electron");
		const notif = new Notification({
			title: "Meeting starting soon",
			body: `"${event.title}" starts in 2 minutes. Start Natively?`,
			actions: [
				{ type: "button", text: "Start Meeting" },
				{ type: "button", text: "Dismiss" },
			],
			sound: true,
		});

		notif.on("action", (event_unused: any, index: number) => {
			if (index === 0) {
				// Start Meeting
				// We need to tell the main process to open window and start meeting
				// Ideally we emit an event that AppState listens to
				this.emit("start-meeting-requested", event);
			}
		});

		notif.on("click", () => {
			// Just open window
			this.emit("open-requested");
		});

		notif.show();
	}

	// =========================================================================
	// Fetch Logic
	// =========================================================================

	public async getUpcomingEvents(
		force: boolean = false,
	): Promise<CalendarEvent[]> {
		if (!this.isConnected || !this.accessToken) return [];

		// Check expiry
		if (this.expiryDate && Date.now() >= this.expiryDate - 60000) {
			await this.refreshAccessToken();
		}

		const events = await this.fetchEventsInternal();
		this.scheduleReminders(events);
		return events;
	}

	private async fetchEventsInternal(): Promise<CalendarEvent[]> {
		if (!this.accessToken) return [];

		const now = new Date();
		const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

		try {
			const response = await axios.get(
				"https://www.googleapis.com/calendar/v3/calendars/primary/events",
				{
					headers: {
						Authorization: `Bearer ${this.accessToken}`,
					},
					params: {
						timeMin: now.toISOString(),
						timeMax: tomorrow.toISOString(),
						singleEvents: true,
						orderBy: "startTime",
					},
				},
			);

			const items = response.data.items || [];

			return items
				.filter((item: any) => {
					// Filter: >= 5 mins, no all-day
					if (!item.start.dateTime || !item.end.dateTime) return false; // All-day events have .date instead of .dateTime

					const start = new Date(item.start.dateTime).getTime();
					const end = new Date(item.end.dateTime).getTime();
					const durationMins = (end - start) / 60000;

					return durationMins >= 5;
				})
				.map((item: any) => ({
					id: item.id,
					title: item.summary || "(No Title)",
					startTime: item.start.dateTime,
					endTime: item.end.dateTime,
					link: this.resolveMeetingLink(item),
					source: "google",
				}));
		} catch (error) {
			console.error("[CalendarManager] Failed to fetch events:", error);
			return [];
		}
	}

	// Intelligent Link Extraction
	private resolveMeetingLink(item: any): string | undefined {
		// 1. Prefer explicit Hangout link (Google Meet) if valid
		if (item.hangoutLink) return item.hangoutLink;

		// 2. Parse description for other providers
		if (!item.description) return undefined;

		return this.extractMeetingLink(item.description);
	}

	private extractMeetingLink(description: string): string | undefined {
		// Regex for common meeting providers
		// Matches zoom.us, teams.microsoft.com, meet.google.com, webex.com
		const providerRegex =
			/(https?:\/\/(?:[a-z0-9-]+\.)?(?:zoom\.us|teams\.microsoft\.com|meet\.google\.com|webex\.com)\/[^\s<>"']+)/gi;

		const matches = description.match(providerRegex);
		if (matches && matches.length > 0) {
			// Deduplicate
			const unique = [...new Set(matches)];
			// Return the first valid provider link
			return unique[0];
		}

		// Fallback: Generic URL (less strict, but riskier)
		// const genericUrlRegex = /(https?:\/\/[^\s<>"']+)/g;
		// ... avoided to prevent picking up random links like "docs.google.com"

		return undefined;
	}

	// Background fetcher could go here if needed
	public async fetchUpcomingEvents() {
		// wrapper to just cache or trigger updates
		return this.getUpcomingEvents();
	}
}
