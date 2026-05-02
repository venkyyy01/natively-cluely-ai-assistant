import { FlaskConical, Mic, Speaker } from "lucide-react";
import type React from "react";

interface AudioConfigSectionProps {
	CustomSelect: React.FC<any>;
	inputDevices: MediaDeviceInfo[];
	outputDevices: MediaDeviceInfo[];
	selectedInput: string;
	selectedOutput: string;
	onInputChange: (id: string) => void;
	onOutputChange: (id: string) => void;
	micLevelBarRef: React.RefObject<HTMLDivElement>;
	selectedOutputSupportsSink: boolean;
	onTestSound: () => Promise<void> | void;
	useExperimentalSck: boolean;
	onToggleExperimentalSck: () => void;
}

export const AudioConfigSection: React.FC<AudioConfigSectionProps> = ({
	CustomSelect,
	inputDevices,
	outputDevices,
	selectedInput,
	selectedOutput,
	onInputChange,
	onOutputChange,
	micLevelBarRef,
	onTestSound,
	useExperimentalSck,
	onToggleExperimentalSck,
}) => {
	return (
		<div>
			<h3 className="text-lg font-bold text-text-primary mb-1">
				Audio Configuration
			</h3>
			<p className="text-xs text-text-secondary mb-5">
				Manage input and output devices.
			</p>

			<div className="space-y-4">
				<CustomSelect
					label="Input Device"
					icon={<Mic size={16} />}
					value={selectedInput}
					options={inputDevices}
					onChange={onInputChange}
					placeholder="Default Microphone"
				/>

				<div>
					<div className="flex justify-between text-xs text-text-secondary mb-2 px-1">
						<span>Input Level</span>
					</div>
					<div className="h-1.5 bg-bg-input rounded-full overflow-hidden">
						<div
							ref={micLevelBarRef}
							className="h-full bg-green-500 transition-all duration-100 ease-out"
							style={{ width: "0%" }}
						/>
					</div>
				</div>

				<div className="h-px bg-border-subtle my-2" />

				<CustomSelect
					label="Output Device"
					icon={<Speaker size={16} />}
					value={selectedOutput}
					options={outputDevices}
					onChange={onOutputChange}
					placeholder="Default Speakers"
				/>

				<div className="flex justify-end">
					<button
						type="button"
						onClick={onTestSound}
						className="text-xs bg-bg-input hover:bg-bg-elevated text-text-primary px-3 py-1.5 rounded-md transition-colors flex items-center gap-2"
					>
						<Speaker size={12} /> Test Sound
					</button>
				</div>

				<div className="h-px bg-border-subtle my-2" />

				<div className="bg-amber-500/5 rounded-xl border border-amber-500/20 p-4">
					<div className="flex items-center justify-between">
						<div className="flex items-start gap-3">
							<div className="mt-0.5 p-1.5 rounded-lg bg-amber-500/10 text-amber-500">
								<FlaskConical size={18} />
							</div>
							<div>
								<div className="flex items-center gap-2 mb-0.5">
									<h3 className="text-sm font-bold text-text-primary">
										SCK Backend
									</h3>
									<span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-indigo-500/20 text-indigo-400 uppercase tracking-wide">
										Alternative
									</span>
								</div>
								<p className="text-xs text-text-secondary leading-relaxed max-w-[300px]">
									Use the ScreenCaptureKit backend. An optimized alternative to
									CoreAudio if you experience any capture issues.
								</p>
							</div>
						</div>
						<button
							type="button"
							onClick={onToggleExperimentalSck}
							className={`w-11 h-6 rounded-full relative transition-colors shrink-0 ${useExperimentalSck ? "bg-amber-500" : "bg-bg-toggle-switch border border-border-muted"}`}
							aria-label="Toggle experimental Screen Capture Kit"
						>
							<div
								className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${useExperimentalSck ? "translate-x-5" : "translate-x-0"}`}
							/>
						</button>
					</div>
				</div>
			</div>
		</div>
	);
};
