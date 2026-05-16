# Windows IDD Driver Scaffold

This directory is the placeholder for the Windows Indirect Display Driver work needed for Layer 2 virtual display isolation.

## Intended Contents
- UMDF2 / IddCx driver project
- INF packaging and signing artifacts
- helper service that coordinates virtual display session lifecycle
- installer and rollback scripts

## Required Next Steps
- create the Visual Studio driver solution
- define the control plane used by the Electron app and compositor helper
- add HLK/attestation signing workflow notes
- validate display enumeration and teardown across sleep, wake, and monitor changes
