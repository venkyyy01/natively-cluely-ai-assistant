import type { EventEmitter } from "node:events";

import type { DirtyRect, StealthFramePayload } from "./types";

interface NativeImageLike {
	toPNG(): Buffer;
	getSize(): { width: number; height: number };
}

interface PaintEventEmitter
	extends Pick<EventEmitter, "on" | "removeListener"> {
	setFrameRate?: (fps: number) => void;
}

interface ShellFrameTarget {
	send(channel: string, payload: StealthFramePayload): void;
}

interface FrameBridgeOptions {
	target: ShellFrameTarget;
	frameRate?: number;
	logger?: Pick<Console, "warn">;
}

const normalizeDirtyRects = (
	dirtyRects: Array<Partial<DirtyRect>>,
): DirtyRect[] =>
	dirtyRects.map((rect) => ({
		x: rect.x ?? 0,
		y: rect.y ?? 0,
		width: rect.width ?? 0,
		height: rect.height ?? 0,
	}));

export class FrameBridge {
	private readonly target: ShellFrameTarget;
	private readonly frameRate: number;
	private readonly logger: Pick<Console, "warn">;
	private paintSource: PaintEventEmitter | null = null;
	private readonly paintListener = (
		_event: unknown,
		dirtyRect: Partial<DirtyRect>,
		image: NativeImageLike,
	) => {
		try {
			const size = image.getSize();
			this.target.send("stealth-shell:frame", {
				dataUrl: `data:image/png;base64,${image.toPNG().toString("base64")}`,
				width: size.width,
				height: size.height,
				scaleFactor: 1,
				dirtyRects: normalizeDirtyRects([dirtyRect]),
			});
		} catch (error) {
			this.logger.warn("[FrameBridge] Failed to forward frame:", error);
		}
	};

	constructor(options: FrameBridgeOptions) {
		this.target = options.target;
		this.frameRate = options.frameRate ?? 30;
		this.logger = options.logger ?? console;
	}

	attach(source: PaintEventEmitter): void {
		this.detach();
		this.paintSource = source;
		source.setFrameRate?.(this.frameRate);
		source.on("paint", this.paintListener);
	}

	detach(): void {
		if (!this.paintSource) {
			return;
		}

		this.paintSource.removeListener("paint", this.paintListener);
		this.paintSource = null;
	}
}
