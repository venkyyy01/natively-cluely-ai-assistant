import { Calendar } from "lucide-react";
import type React from "react";

interface CalendarSettingsSectionProps {
	calendarStatus: { connected?: boolean; email?: string };
	isCalendarsLoading: boolean;
	setIsCalendarsLoading: (value: boolean) => void;
	setCalendarStatus: (value: any) => void;
}

export const CalendarSettingsSection: React.FC<
	CalendarSettingsSectionProps
> = ({
	calendarStatus,
	isCalendarsLoading,
	setIsCalendarsLoading,
	setCalendarStatus,
}) => {
	return (
		<div className="space-y-6 animated fadeIn h-full">
			<div>
				<h3 className="text-lg font-bold text-text-primary mb-2">
					Visible Calendars
				</h3>
				<p className="text-xs text-text-secondary mb-4">
					Upcoming meetings are synchronized from these calendars
				</p>
			</div>

			<div className="bg-bg-card rounded-xl p-6 border border-border-subtle flex flex-col items-start gap-4">
				{calendarStatus.connected ? (
					<div className="w-full flex items-center justify-between">
						<div className="flex items-center gap-4">
							<div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-500">
								<Calendar size={20} />
							</div>
							<div>
								<h4 className="text-sm font-medium text-text-primary">
									Google Calendar
								</h4>
								<p className="text-xs text-text-secondary">
									Connected as {calendarStatus.email || "User"}
								</p>
							</div>
						</div>

						<button
							onClick={async () => {
								setIsCalendarsLoading(true);
								try {
									await window.electronAPI.calendarDisconnect();
									const status = await window.electronAPI.getCalendarStatus();
									setCalendarStatus(status);
								} finally {
									setIsCalendarsLoading(false);
								}
							}}
							disabled={isCalendarsLoading}
							className="px-3 py-1.5 bg-bg-input hover:bg-bg-elevated border border-border-subtle text-text-primary rounded-md text-xs font-medium transition-colors"
						>
							{isCalendarsLoading ? "Disconnecting..." : "Disconnect"}
						</button>
					</div>
				) : (
					<div className="w-full py-4">
						<div className="mb-4">
							<Calendar size={24} className="text-text-tertiary mb-3" />
							<h4 className="text-sm font-bold text-text-primary mb-1">
								No calendars
							</h4>
							<p className="text-xs text-text-secondary">
								Get started by connecting a Google account.
							</p>
						</div>

						<button
							onClick={async () => {
								setIsCalendarsLoading(true);
								try {
									const res = await window.electronAPI.calendarConnect();
									if (res.success) {
										const status = await window.electronAPI.getCalendarStatus();
										setCalendarStatus(status);
									}
								} finally {
									setIsCalendarsLoading(false);
								}
							}}
							disabled={isCalendarsLoading}
							className="bg-[#303033] hover:bg-[#3A3A3D] text-white px-4 py-2 rounded-lg text-xs font-medium transition-all flex items-center gap-2.5"
						>
							<svg
								viewBox="0 0 24 24"
								width="14"
								height="14"
								xmlns="http://www.w3.org/2000/svg"
							>
								<g transform="matrix(1, 0, 0, 1, 27.009001, -39.238998)">
									<path
										fill="#4285F4"
										d="M -3.264 51.509 C -3.264 50.719 -3.334 49.969 -3.454 49.239 L -14.754 49.239 L -14.754 53.749 L -8.284 53.749 C -8.574 55.229 -9.424 56.479 -10.684 57.329 L -10.684 60.329 L -6.824 60.329 C -4.564 58.239 -3.264 55.159 -3.264 51.509 Z"
									/>
									<path
										fill="#34A853"
										d="M -14.754 63.239 C -11.514 63.239 -8.804 62.159 -6.824 60.329 L -10.684 57.329 C -11.764 58.049 -13.134 58.489 -14.754 58.489 C -17.884 58.489 -20.534 56.379 -21.484 53.529 L -25.464 53.529 L -25.464 56.619 C -23.494 60.539 -19.444 63.239 -14.754 63.239 Z"
									/>
									<path
										fill="#FBBC05"
										d="M -21.484 53.529 C -21.734 52.809 -21.864 52.039 -21.864 51.239 C -21.864 50.439 -21.734 49.669 -21.484 48.949 L -21.484 45.859 L -25.464 45.859 C -26.284 47.479 -26.754 49.299 -26.754 51.239 C -26.754 53.179 -26.284 54.999 -25.464 56.619 L -21.484 53.529 Z"
									/>
									<path
										fill="#EA4335"
										d="M -14.754 43.989 C -12.984 43.989 -11.404 44.599 -10.154 45.789 L -6.734 42.369 C -8.804 40.429 -11.514 39.239 -14.754 39.239 C -19.444 39.239 -23.494 41.939 -25.464 45.859 L -21.484 48.949 C -20.534 46.099 -17.884 43.989 -14.754 43.989 Z"
									/>
								</g>
							</svg>
							{isCalendarsLoading ? "Connecting..." : "Connect Google"}
						</button>
					</div>
				)}
			</div>
		</div>
	);
};
