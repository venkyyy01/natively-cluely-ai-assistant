# Driver Contract

## Responsibilities
- create and remove a virtual display on request
- report driver/session readiness
- expose a stable device interface GUID for the helper service
- surface structured failure reasons for installer and runtime logs

## Inputs
- session id
- requested resolution
- frame source token

## Outputs
- display id
- ready state
- failure reason
