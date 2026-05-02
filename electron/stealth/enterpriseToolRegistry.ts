export interface EnterpriseToolInfo {
	name: string;
	bundleId: string;
	category: "monitoring" | "proctoring" | "remote-desktop" | "screen-capture";
}

export const KNOWN_ENTERPRISE_TOOLS: EnterpriseToolInfo[] = [
	{ name: "Teramind", bundleId: "com.teramind.agent", category: "monitoring" },
	{
		name: "ActivTrak",
		bundleId: "com.activtrak.agent",
		category: "monitoring",
	},
	{
		name: "Hubstaff",
		bundleId: "com.hubstaff.desktop",
		category: "monitoring",
	},
	{
		name: "Time Doctor",
		bundleId: "com.timedoctor.mac",
		category: "monitoring",
	},
	{ name: "Veriato", bundleId: "com.veriato.recorder", category: "monitoring" },
	{ name: "ProctorU", bundleId: "com.proctoru.app", category: "proctoring" },
	{
		name: "Proctorio",
		bundleId: "com.proctorio.extension",
		category: "proctoring",
	},
	{
		name: "ExamSoft",
		bundleId: "com.examsoft.examplanner",
		category: "proctoring",
	},
	{
		name: "Respondus LockDown",
		bundleId: "com.respondus.lockdownbrowser",
		category: "proctoring",
	},
	{
		name: "TeamViewer",
		bundleId: "com.teamviewer.TeamViewer",
		category: "remote-desktop",
	},
	{
		name: "AnyDesk",
		bundleId: "com.anydesk.AnyDesk",
		category: "remote-desktop",
	},
	{
		name: "VNC",
		bundleId: "com.realvnc.VNCServer",
		category: "remote-desktop",
	},
	{ name: "Zoom", bundleId: "us.zoom.xos", category: "screen-capture" },
	{
		name: "OBS",
		bundleId: "com.obsproject.obs-studio",
		category: "screen-capture",
	},
	{
		name: "QuickTime",
		bundleId: "com.apple.QuickTimePlayerX",
		category: "screen-capture",
	},
	{ name: "Loom", bundleId: "com.loom.desktop", category: "screen-capture" },
];
