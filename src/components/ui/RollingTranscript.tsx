import { memo, useEffect, useRef } from "react";

interface RollingTranscriptProps {
	text: string;
	isActive?: boolean;
}

/**
 * RollingTranscript - A single-line horizontally scrolling transcript bar
 *
 * Displays real-time speech transcription as a smooth left-scrolling text track.
 * Features:
 * - Fixed height, single line only
 * - Text flows from right to left as new words arrive
 * - Edge fade gradients for visual polish
 */
// Memoized RollingTranscript component for performance optimization
const RollingTranscript = memo<RollingTranscriptProps>(
	({ text, isActive = true }) => {
		const containerRef = useRef<HTMLDivElement>(null);

		// Auto-scroll to the end when text updates
		useEffect(() => {
			if (containerRef.current) {
				containerRef.current.scrollLeft = containerRef.current.scrollWidth;
			}
		}, []);

		if (!text) return null;

		return (
			<div className="relative w-[90%] mx-auto pt-2">
				{/* Scrolling Container */}
				<div
					ref={containerRef}
					className="overflow-hidden whitespace-nowrap text-right scroll-smooth"
					style={{
						maskImage:
							"linear-gradient(to right, transparent, black 10%, black 90%, transparent)",
					}}
				>
					<span className="inline-flex items-center text-[13px] text-white/40 italic leading-7 transition-all duration-300">
						{text}
						{isActive && (
							<span className="inline-flex items-center ml-2">
								<span className="w-1 h-1 bg-green-500/60 rounded-full animate-pulse" />
							</span>
						)}
					</span>
				</div>
			</div>
		);
	},
);

// Set display name for debugging
RollingTranscript.displayName = "RollingTranscript";

export default RollingTranscript;
