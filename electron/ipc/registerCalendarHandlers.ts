import { ipcSchemas, parseIpcInput } from "../ipcValidation";
import type { AppState } from "../main";
import type { SafeHandle, SafeHandleValidated } from "./registerTypes";

type RegisterCalendarHandlersDeps = {
	appState: AppState;
	safeHandle: SafeHandle;
	safeHandleValidated: SafeHandleValidated;
};

export function registerCalendarHandlers({
	safeHandle,
	safeHandleValidated,
}: RegisterCalendarHandlersDeps): void {
	safeHandle("calendar-connect", async () => {
		const { CalendarManager } = require("../services/CalendarManager");
		await CalendarManager.getInstance().startAuthFlow();
		return { success: true };
	});

	safeHandle("calendar-disconnect", async () => {
		const { CalendarManager } = require("../services/CalendarManager");
		await CalendarManager.getInstance().disconnect();
		return { success: true };
	});

	safeHandle("get-calendar-status", async () => {
		const { CalendarManager } = require("../services/CalendarManager");
		return CalendarManager.getInstance().getConnectionStatus();
	});

	safeHandle("get-upcoming-events", async () => {
		const { CalendarManager } = require("../services/CalendarManager");
		return CalendarManager.getInstance().getUpcomingEvents();
	});

	safeHandle("calendar-refresh", async () => {
		const { CalendarManager } = require("../services/CalendarManager");
		await CalendarManager.getInstance().refreshState();
		return { success: true };
	});

	safeHandleValidated(
		"get-calendar-attendees",
		(args) =>
			[
				parseIpcInput(
					ipcSchemas.calendarEventId,
					args[0],
					"get-calendar-attendees",
				),
			] as const,
		async (_event, eventId: string) => {
			try {
				const { CalendarManager } = require("../services/CalendarManager");
				const cm = CalendarManager.getInstance();
				const events = await cm.getUpcomingEvents();
				const event = events?.find((entry: any) => entry.id === eventId);

				if (event && event.attendees) {
					return event.attendees
						.map((attendee: any) => ({
							email: attendee.email,
							name: attendee.displayName || attendee.email?.split("@")[0] || "",
						}))
						.filter((attendee: any) => attendee.email);
				}

				return [];
			} catch (error: any) {
				console.error("Error getting calendar attendees:", error);
				return [];
			}
		},
	);
}
