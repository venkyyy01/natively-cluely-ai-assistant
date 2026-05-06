export interface ScreenshotFacadeDeps {
	deleteScreenshot: (
		path: string,
	) => Promise<{ success: boolean; error?: string }>;
	takeScreenshot: () => Promise<string>;
	takeSelectiveScreenshot: () => Promise<string>;
	getImagePreview: (filepath: string) => Promise<string>;
	getView: () => "queue" | "solutions";
	getScreenshotQueue: () => string[];
	getExtraScreenshotQueue: () => string[];
	clearQueues: () => void;
}

export class ScreenshotFacade {
	constructor(private readonly deps: ScreenshotFacadeDeps) {}

	deleteScreenshot(
		path: string,
	): Promise<{ success: boolean; error?: string }> {
		return this.deps.deleteScreenshot(path);
	}

	takeScreenshot(): Promise<string> {
		return this.deps.takeScreenshot();
	}

	takeSelectiveScreenshot(): Promise<string> {
		return this.deps.takeSelectiveScreenshot();
	}

	getImagePreview(filepath: string): Promise<string> {
		return this.deps.getImagePreview(filepath);
	}

	getView(): "queue" | "solutions" {
		return this.deps.getView();
	}

	getScreenshotQueue(): string[] {
		return this.deps.getScreenshotQueue();
	}

	getExtraScreenshotQueue(): string[] {
		return this.deps.getExtraScreenshotQueue();
	}

	clearQueues(): void {
		this.deps.clearQueues();
	}
}
