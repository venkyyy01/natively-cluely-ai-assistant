import test from 'node:test'
import assert from 'node:assert/strict'

import { MeetingState, MeetingStateMachine } from '../utils/MeetingStateMachine'

test('MeetingStateMachine reset clears failed startup state and allows retry', async () => {
  const machine = new MeetingStateMachine()

  assert.equal(await machine.startMeeting('initial start'), true)
  assert.equal(machine.getCurrentState(), MeetingState.INITIALIZING)

  assert.equal(await machine.setErrorState(new Error('startup failed'), 'startup failed'), true)
  assert.equal(machine.getCurrentState(), MeetingState.ERROR)

  await machine.reset('recover failed startup')
  assert.equal(machine.getCurrentState(), MeetingState.IDLE)

  assert.equal(await machine.startMeeting('retry start'), true)
  assert.equal(machine.getCurrentState(), MeetingState.INITIALIZING)
})

test('MeetingStateMachine reset clears stopping state and allows the next meeting to start', async () => {
  const machine = new MeetingStateMachine()

  assert.equal(await machine.startMeeting('start'), true)
  assert.equal(await machine.completeInitialization('ready'), true)
  assert.equal(machine.getCurrentState(), MeetingState.ACTIVE)

  assert.equal(await machine.stopMeeting('stop'), true)
  assert.equal(machine.getCurrentState(), MeetingState.STOPPING)

  await machine.reset('cleanup complete')
  assert.equal(machine.getCurrentState(), MeetingState.IDLE)

  assert.equal(await machine.startMeeting('next start'), true)
  assert.equal(machine.getCurrentState(), MeetingState.INITIALIZING)
})
