# macOS Native Stealth: Cursor Freeze & Software Cursor

This plan addresses the vulnerability where the OS hardware cursor is captured in live screenshares when interacting with the Natively overlay on macOS.

## Goal
Intercept global mouse events at the OS level (`CGEventTap`) before the window server processes them. If the mouse is moving over the overlay, we freeze the hardware cursor in place at the edge of the overlay and route the movement to a React software cursor.

## Requirements

1. **Native Swift Modification**  
   This requires adding a C/Swift native node addon to create a `CGEventTap`. Natively must be granted Accessibility Permissions in macOS System Settings for this to work.

2. **Trackpad vs Mouse Deltas**  
   Because we are swallowing the OS event, the hardware cursor stops moving. We must manually calculate the virtual cursor position by accumulating `deltaX` and `deltaY` from the intercepted events. This requires careful math to ensure the software cursor feels smooth and matches OS acceleration curves.

## Proposed Architecture

### 1. Native macOS Module (`CGEventTap`)
**File:** `electron/native/macosCursorHook.swift` (or similar)
- Create a `CGEventTapCreate(kCGHIDEventTap, ...)` listening for `kCGEventMouseMoved`, `kCGEventLeftMouseDown`, `kCGEventLeftMouseUp`, and `kCGEventScrollWheel`.
- Expose a method to set the "Overlay Bounding Box" from Electron.
- In the callback:
  - Read the `kCGMouseEventDeltaX` and `Y`.
  - Calculate the virtual position.
  - If the virtual position is inside the bounding box:
    - Send the virtual X/Y and click states to Electron via a thread-safe IPC callback.
    - Return `NULL` to swallow the event (freezing the hardware cursor).
  - If outside, return the event normally.

### 2. Electron Main Process
**File:** `electron/WindowHelper.ts`
- Pass the overlay's bounds (`x, y, width, height`) to the native module whenever the window moves or resizes.
- Listen for the IPC callbacks from the native module.
- Forward the virtual mouse events to the React frontend (`webContents.send('virtual-mouse-event', data)`).

### 3. React Frontend
**File:** `src/components/SyntheticCursor.tsx`
- A React component absolutely positioned over the entire overlay `pointer-events-none z-50`.
- Renders an SVG matching the standard macOS arrow cursor.
- Updates its `left` and `top` style based on the `virtual-mouse-event` IPC messages.

**File:** `src/components/NativelyInterface.tsx` (Synthetic Interaction)
- Natively trigger `onClick`, `onHover`, and `onScroll` events on React components based on the virtual cursor coordinates, since the browser won't be receiving actual OS mouse events!

## Verification Plan

### Automated Tests
- Test the coordinate mapping logic (ensuring virtual X/Y stays within bounds).

### Manual Verification
- Move the mouse rapidly across the screen. Verify the hardware cursor stops dead at the edge of the overlay.
- Verify the synthetic cursor appears inside the overlay and feels 1:1 with hardware movement.
- Verify clicking buttons in the overlay works using the synthetic cursor.
- Open OBS/QuickTime Screen Recording and verify only the frozen hardware cursor is visible!
