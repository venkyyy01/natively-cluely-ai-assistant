import React, { useEffect, useRef, useState } from 'react'
import { getOptionalElectronMethod } from '../lib/electronApi'

type VirtualMouseEvent = {
  kind: 'move' | 'down' | 'up' | 'scroll'
  button: number
  x: number
  y: number
  globalX: number
  globalY: number
  scrollDx: number
  scrollDy: number
}

/**
 * Software cursor rendered inside the overlay window. Receives virtual
 * mouse events from the macOS cursor hook (CGEventTap) via preload IPC,
 * paints an SVG cursor at the live position, and synthesises hover / click
 * events on real DOM elements underneath so React buttons keep working.
 *
 * Why this matters for stealth: the OS hardware cursor is captured into
 * any screen share. By freezing it at the overlay edge and replacing it
 * with a React-rendered cursor inside the capture-excluded overlay window,
 * the proctor sees a cursor that simply stops at the edge of the overlay
 * — no mysterious clicks on empty space, no cursor jitter inside the
 * Natively rectangle.
 *
 * Failure modes:
 *   - If `setCursorHook` returns `{ installed: false }` (Accessibility
 *     denied / non-mac platform), this component renders nothing and
 *     the OS cursor handles input normally. No behavioural change.
 *   - If the IPC stream stalls, the last-painted position remains; the
 *     OS cursor is still frozen so the screen-share view stays stable.
 */
export const SyntheticCursor: React.FC = () => {
  const [installed, setInstalled] = useState(false)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const [pressed, setPressed] = useState(false)
  const lastHoveredRef = useRef<Element | null>(null)

  // Phase 1: try to install the native hook. Re-run when the component
  // mounts (overlay opens). The Electron main process owns lifecycle
  // beyond that — when the overlay is hidden, it disarms the tap; when
  // it shows again, it re-arms. We do not need to re-call here.
  useEffect(() => {
    const setCursorHook = getOptionalElectronMethod('setCursorHook')
    if (!setCursorHook) {
      setInstalled(false)
      return
    }

    let cancelled = false
    void setCursorHook(true)
      .then((result) => {
        if (cancelled) return
        setInstalled(Boolean(result?.installed))
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[SyntheticCursor] setCursorHook failed:', err)
        setInstalled(false)
      })

    return () => {
      cancelled = true
      // Disarm on unmount — the controller in main also clears itself on
      // overlay 'closed', so this is belt-and-braces for hot reload.
      void setCursorHook(false).catch(() => {
        /* ignore */
      })
    }
  }, [])

  // Phase 2: subscribe to virtual mouse events and synthesize hover/click.
  useEffect(() => {
    if (!installed) return

    const onVirtualMouseEvent = getOptionalElectronMethod('onVirtualMouseEvent')
    if (!onVirtualMouseEvent) return

    const synthesize = (event: VirtualMouseEvent) => {
      // Use overlay-local coords directly. `elementFromPoint` operates in
      // the same coord space as window.scrollX/scrollY-relative client
      // coords, which (for a frameless overlay with no scrollable root)
      // equals the local x/y the controller emitted.
      const target = document.elementFromPoint(event.x, event.y) as HTMLElement | null

      if (event.kind === 'move' || event.kind === 'down' || event.kind === 'up') {
        // Update hover chain. When the underlying element changes, fire
        // synthetic mouseleave/mouseenter so React's onMouseEnter/Leave
        // still work even though the OS event was suppressed.
        if (target !== lastHoveredRef.current) {
          if (lastHoveredRef.current instanceof HTMLElement) {
            dispatchSynthetic(lastHoveredRef.current, 'mouseleave', event)
            dispatchSynthetic(lastHoveredRef.current, 'mouseout', event, true)
          }
          if (target) {
            dispatchSynthetic(target, 'mouseenter', event)
            dispatchSynthetic(target, 'mouseover', event, true)
          }
          lastHoveredRef.current = target
        }
        if (event.kind === 'move' && target) {
          dispatchSynthetic(target, 'mousemove', event, true)
        }
      }

      if (event.kind === 'down' && target) {
        setPressed(true)
        dispatchSynthetic(target, 'mousedown', event, true)
      }
      if (event.kind === 'up' && target) {
        setPressed(false)
        dispatchSynthetic(target, 'mouseup', event, true)
        // Synthesize a click only on left button.
        if (event.button === 0) {
          dispatchSynthetic(target, 'click', event, true)
        }
      }
      if (event.kind === 'scroll' && target) {
        target.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            clientX: event.x,
            clientY: event.y,
            deltaX: -event.scrollDx,
            // CG axis 1 (Y) is positive when scrolling up; DOM `deltaY` is
            // positive when scrolling down. Flip the sign so wheel handlers
            // see "natural" direction matching the OS gesture.
            deltaY: -event.scrollDy,
          })
        )
      }

      setPosition({ x: event.x, y: event.y })
    }

    const unsubscribe = onVirtualMouseEvent(synthesize)
    return () => {
      try {
        unsubscribe()
      } catch {
        /* ignore */
      }
      lastHoveredRef.current = null
    }
  }, [installed])

  if (!installed || !position) return null

  return (
    <>
      {/*
        Hide the OS cursor inside the overlay surface while the synthetic
        cursor is mounted. This is purely cosmetic — the OS cursor is
        already frozen at the overlay edge by the CGEventTap, so there is
        usually nothing to hide; the rule only matters if the user moves
        the cursor inside the overlay before the first virtual event lands.
        `cursor: none` is scoped to the overlay window's html root so the
        rest of the system (settings, launcher, other apps) is unaffected.
      */}
      <style>{`html, body, * { cursor: none !important; }`}</style>
      <div
        aria-hidden
        style={{
          position: 'fixed',
          left: position.x,
          top: position.y,
          pointerEvents: 'none',
          zIndex: 2147483647,
          transform: pressed ? 'scale(0.92)' : 'scale(1)',
          transition: 'transform 80ms ease-out',
          willChange: 'left, top, transform',
        }}
      >
        {/*
          macOS-style arrow cursor. The white outline keeps it visible on any
          background; the coordinates were lifted from the standard system
          cursor SVG path. The hot-spot is the tip of the arrow at (0, 0).
        */}
        <svg width="20" height="22" viewBox="0 0 20 22" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M1 1 L1 17 L5.5 13 L8 19 L11 18 L8.5 12 L14.5 12 Z"
            fill="black"
            stroke="white"
            strokeWidth="1"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </>
  )
}

function dispatchSynthetic(
  target: HTMLElement,
  type: string,
  event: VirtualMouseEvent,
  bubbles: boolean = true
) {
  try {
    const init: MouseEventInit = {
      bubbles,
      cancelable: true,
      clientX: event.x,
      clientY: event.y,
      screenX: event.globalX,
      screenY: event.globalY,
      button: event.button >= 0 ? event.button : 0,
      buttons: event.kind === 'down' ? 1 : 0,
    }
    target.dispatchEvent(new MouseEvent(type, init))
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[SyntheticCursor] failed to dispatch synthetic event:', err)
  }
}

export default SyntheticCursor
