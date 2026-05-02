import assert from "node:assert";
import { describe, it } from "node:test";
import type { ProtectionEventType } from "../stealth/protectionStateTypes";
import {
	type VisibilityCapableWindow,
	VisibilityController,
} from "../stealth/VisibilityController";

class FakeVisibilityWindow implements VisibilityCapableWindow {
	public showCalls = 0;
	public showInactiveCalls = 0;
	public hideCalls = 0;
	public opacityCalls: number[] = [];
	public destroyed = false;
	public visible = false;

	show(): void {
		this.showCalls += 1;
		this.visible = true;
	}

	showInactive(): void {
		this.showInactiveCalls += 1;
		this.visible = true;
	}

	hide(): void {
		this.hideCalls += 1;
		this.visible = false;
	}

	setOpacity(value: number): void {
		this.opacityCalls.push(value);
	}

	isDestroyed(): boolean {
		return this.destroyed;
	}

	isVisible(): boolean {
		return this.visible;
	}

	getMediaSourceId(): string {
		return "window:visibility:0";
	}
}

describe("VisibilityController", () => {
	it("routes show through request/show event pair without changing behavior", () => {
		const events: Array<{ type: ProtectionEventType; visible?: boolean }> = [];
		const controller = new VisibilityController({
			recordProtectionEvent(type, context) {
				events.push({ type, visible: context?.visible });
			},
		});
		const win = new FakeVisibilityWindow();

		controller.requestShow(win, { source: "test", windowRole: "primary" });

		assert.equal(win.showCalls, 1);
		assert.deepEqual(
			events.map((event) => event.type),
			["show-requested", "shown"],
		);
		assert.deepEqual(
			events.map((event) => event.visible),
			[false, true],
		);
	});

	it("routes hide through request/hidden event pair without changing behavior", () => {
		const events: ProtectionEventType[] = [];
		const controller = new VisibilityController({
			recordProtectionEvent(type) {
				events.push(type);
			},
		});
		const win = new FakeVisibilityWindow();
		win.visible = true;

		controller.requestHide(win, { source: "test", windowRole: "primary" });

		assert.equal(win.hideCalls, 1);
		assert.deepEqual(events, ["hide-requested", "hidden"]);
	});

	it("uses showInactive when available", () => {
		const controller = new VisibilityController({ recordProtectionEvent() {} });
		const win = new FakeVisibilityWindow();

		controller.requestShowInactive(win, {
			source: "test",
			windowRole: "auxiliary",
		});

		assert.equal(win.showCalls, 0);
		assert.equal(win.showInactiveCalls, 1);
	});

	it("passes opacity changes through without visibility events", () => {
		const events: ProtectionEventType[] = [];
		const controller = new VisibilityController({
			recordProtectionEvent(type) {
				events.push(type);
			},
		});
		const win = new FakeVisibilityWindow();

		controller.setOpacity(win, 0.5, { source: "test", windowRole: "primary" });

		assert.deepEqual(win.opacityCalls, [0.5]);
		assert.deepEqual(events, []);
	});

	it("does not call destroyed windows", () => {
		const events: ProtectionEventType[] = [];
		const controller = new VisibilityController({
			recordProtectionEvent(type) {
				events.push(type);
			},
		});
		const win = new FakeVisibilityWindow();
		win.destroyed = true;

		controller.requestShow(win, { source: "test", windowRole: "primary" });
		controller.requestHide(win, { source: "test", windowRole: "primary" });
		controller.setOpacity(win, 1, { source: "test", windowRole: "primary" });

		assert.equal(win.showCalls, 0);
		assert.equal(win.hideCalls, 0);
		assert.deepEqual(win.opacityCalls, []);
		assert.deepEqual(events, []);
	});
});
