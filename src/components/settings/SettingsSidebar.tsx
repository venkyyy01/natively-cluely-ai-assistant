import {
	Calendar,
	FlaskConical,
	Info,
	Keyboard,
	LogOut,
	Mic,
	Monitor,
	User,
	X,
} from "lucide-react";
import type React from "react";

interface SettingsSidebarProps {
	activeTab: string;
	setActiveTab: (
		tab:
			| "general"
			| "ai-providers"
			| "calendar"
			| "audio"
			| "keybinds"
			| "profile"
			| "about",
	) => void;
	onClose: () => void;
	onProfileOpen: () => void;
}

export const SettingsSidebar: React.FC<SettingsSidebarProps> = ({
	activeTab,
	setActiveTab,
	onClose,
	onProfileOpen,
}) => {
	const items = [
		{ id: "general", label: "General", icon: <Monitor size={16} /> },
		{
			id: "ai-providers",
			label: "AI Providers",
			icon: <FlaskConical size={16} />,
		},
		{ id: "calendar", label: "Calendar", icon: <Calendar size={16} /> },
		{ id: "audio", label: "Audio", icon: <Mic size={16} /> },
		{ id: "keybinds", label: "Keybinds", icon: <Keyboard size={16} /> },
		{ id: "profile", label: "Profile Intelligence", icon: <User size={16} /> },
		{ id: "about", label: "About", icon: <Info size={16} /> },
	] as const;

	return (
		<div className="w-64 bg-bg-sidebar flex flex-col border-r border-border-subtle">
			<div className="p-6">
				<h2 className="font-semibold text-gray-400 text-xs uppercase tracking-wider mb-2">
					Settings
				</h2>
				<nav className="space-y-1">
					{items.map((item) => (
						<button
							key={item.id}
							type="button"
							onClick={() => {
								setActiveTab(item.id);
								if (item.id === "profile") {
									onProfileOpen();
								}
							}}
							className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-3 ${activeTab === item.id ? "bg-bg-item-active text-text-primary" : "text-text-secondary hover:text-text-primary hover:bg-bg-item-active/50"}`}
						>
							{item.icon} {item.label}
						</button>
					))}
				</nav>
			</div>

			<div className="mt-auto p-6 border-t border-border-subtle">
				<button
					type="button"
					onClick={() => window.electronAPI.quitApp()}
					className="w-full text-left px-3 py-2 rounded-lg text-sm font-medium text-red-400 hover:bg-red-500/10 transition-colors flex items-center gap-3"
				>
					<LogOut size={16} /> Quit Natively
				</button>
				<button
					type="button"
					onClick={onClose}
					className="group mt-2 w-full text-left px-3 py-2 rounded-lg text-sm font-medium text-text-secondary hover:text-text-primary hover:bg-bg-item-active/50 transition-colors flex items-center gap-3"
				>
					<X size={18} className="group-hover:text-red-500 transition-colors" />{" "}
					Close
				</button>
			</div>
		</div>
	);
};
