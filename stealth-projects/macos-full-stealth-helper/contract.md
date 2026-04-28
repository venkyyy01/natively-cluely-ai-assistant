# macOS Full Stealth Helper Contract (v1)

Status: draft v1 scaffold for NSH-001.

## Goals

- Define a versioned control-plane contract for the native macOS full stealth helper.
- Keep the contract fail-closed: degraded/blocked outcomes must never imply partial stealth success.
- Allow Electron runtime to integrate through a typed bridge while preserving fallback behavior.

## Protocol

- Name: `macos-full-stealth-helper`
- Version: `1`
- Transport: JSON envelopes over helper IPC channel (`serve` mode or XPC host shim)

### Request Envelope

```json
{
  "id": "req-1",
  "version": 1,
  "method": "arm",
  "params": {}
}
```

### Response Envelope

```json
{
  "id": "req-1",
  "version": 1,
  "ok": true,
  "result": {},
  "error": null
}
```

## Methods

### `arm(config)`

Arms the native helper for guarded presentation.

Request params:

```json
{
  "sessionId": "native-stealth-123",
  "presentationMode": "native-fullscreen-presenter",
  "displayPreference": "dedicated-display",
  "reason": "policy-required"
}
```

Response result:

```json
{
  "outcome": "ok",
  "failClosed": false,
  "presentationAllowed": true,
  "blockers": [],
  "data": {
    "sessionId": "native-stealth-123",
    "state": "creating"
  }
}
```

### `heartbeat()`

Checks helper health for active session.

Request params:

```json
{
  "sessionId": "native-stealth-123"
}
```

Response result:

```json
{
  "outcome": "ok",
  "failClosed": false,
  "presentationAllowed": true,
  "blockers": [],
  "data": {
    "sessionId": "native-stealth-123",
    "state": "presenting",
    "surfaceAttached": true,
    "presenting": true,
    "recoveryPending": false,
    "blockers": [],
    "lastTransitionAt": "2026-04-09T12:00:00.000Z"
  }
}
```

### `submitFrame(surfaceId, region)`

Submits a frame region update for native presenter state tracking.

Request params:

```json
{
  "sessionId": "native-stealth-123",
  "surfaceId": "surface-native-stealth-123",
  "region": {
    "x": 0,
    "y": 0,
    "width": 1280,
    "height": 720
  }
}
```

Response result:

```json
{
  "accepted": true
}
```

### `relayInput(event)`

Relays shell input for native presenter if required.

Request params:

```json
{
  "sessionId": "native-stealth-123",
  "event": {
    "kind": "mouse",
    "type": "mouseDown"
  }
}
```

Response result:

```json
{
  "accepted": true
}
```

### `fault(reason)`

Forces immediate fail-closed teardown of native stealth session.

Request params:

```json
{
  "sessionId": "native-stealth-123",
  "reason": "stealth heartbeat missed"
}
```

Response result:

```json
{
  "released": true
}
```

## Compatibility Rules

- The helper must reject requests with unknown major `version`.
- The bridge must treat non-`ok` responses as fail-closed faults.
- If helper connection fails, runtime falls back to existing Electron stealth path.
