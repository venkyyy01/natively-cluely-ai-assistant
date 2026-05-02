import type {
	ProtectionEventContext,
	ProtectionEventType,
	ProtectionSnapshot,
} from "./protectionStateTypes";

export interface VisibilityCapableWindow {
	show?: () => void;
	showInactive?: () => void;
	hide?: () => void;
	setOpacity?: (value: number) => void;
	isDestroyed?: () => boolean;
	isVisible?: () => boolean;
	getMediaSourceId?: () => string;
}

export interface VisibilityOperationContext extends ProtectionEventContext {
	source: string;
	windowRole?: "primary" | "auxiliary" | "unknown";
}

export interface VisibilityControllerOptions {
	recordProtectionEvent: (
		type: ProtectionEventType,
		context?: ProtectionEventContext,
	) => ProtectionSnapshot | undefined;
	logger?: Pick<Console, "warn">;
}

function isDestroyed(win: VisibilityCapableWindow | null | undefined): boolean {
	return !win || (typeof win.isDestroyed === "function" && win.isDestroyed());
}

export class VisibilityController {
	private readonly recordProtectionEvent: VisibilityControllerOptions["recordProtectionEvent"];
	private readonly logger?: Pick<Console, "warn">;

	constructor(options: VisibilityControllerOptions) {
		this.recordProtectionEvent = options.recordProtectionEvent;
		this.logger = options.logger;
	}

	requestShow(
		win: VisibilityCapableWindow | null | undefined,
		context: VisibilityOperationContext,
	): void {
		if (isDestroyed(win)) {
			return;
		}

		this.record("show-requested", win, context);
		if (typeof win.show !== "function") {
			this.logger?.warn?.(
				"[VisibilityController] requestShow called for window without show()",
				context,
			);
			return;
		}
		win.show();
		this.record("shown", win, context);
	}

	requestShowInactive(
		win: VisibilityCapableWindow | null | undefined,
		context: VisibilityOperationContext,
	): void {
		if (isDestroyed(win)) {
			return;
		}

		this.record("show-requested", win, context);
		if (typeof win.showInactive === "function") {
			win.showInactive();
		} else if (typeof win.show === "function") {
			win.show();
		} else {
			this.logger?.warn?.(
				"[VisibilityController] requestShowInactive called for window without show/showInactive()",
				context,
			);
			return;
		}
		this.record("shown", win, context);
	}

	requestHide(
		win: VisibilityCapableWindow | null | undefined,
		context: VisibilityOperationContext,
	): void {
		if (isDestroyed(win)) {
			return;
		}

		this.record("hide-requested", win, context);
		if (typeof win.hide !== "function") {
			this.logger?.warn?.(
				"[VisibilityController] requestHide called for window without hide()",
				context,
			);
			return;
		}
		win.hide();
		this.record("hidden", win, context);
	}

	setOpacity(
		win: VisibilityCapableWindow | null | undefined,
		value: number,
		_context: VisibilityOperationContext,
	): void {
		if (isDestroyed(win) || typeof win?.setOpacity !== "function") {
			return;
		}

		win.setOpacity(value);
	}

	markProtectionApplied(
		win: VisibilityCapableWindow | null | undefined,
		context: VisibilityOperationContext,
	): void {
		if (isDestroyed(win)) {
			return;
		}

		this.record("protection-apply-finished", win, context);
	}

	markVerification(
		win: VisibilityCapableWindow | null | undefined,
		verified: boolean,
		context: VisibilityOperationContext,
	): void {
		if (isDestroyed(win)) {
			return;
		}

		this.record(
			verified ? "verification-passed" : "verification-failed",
			win,
			context,
		);
	}

	private record(
		type: ProtectionEventType,
		win: VisibilityCapableWindow,
		context: VisibilityOperationContext,
	): void {
		let windowId = context.windowId;
		if (!windowId) {
			try {
				windowId = win.getMediaSourceId?.();
			} catch {
				windowId = undefined;
			}
		}

		this.recordProtectionEvent(type, {
			...context,
			windowId,
			visible:
				typeof win.isVisible === "function" ? win.isVisible() : context.visible,
		});
	}
}
