import test from 'node:test';
import assert from 'node:assert/strict';

import { SettingsFacade } from '../runtime/SettingsFacade';

test('SettingsFacade delegates settings state operations', () => {
  const calls: string[] = [];

  const facade = new SettingsFacade({
    setConsciousModeEnabled: (enabled: boolean) => {
      calls.push(`setConscious:${enabled}`);
      return true;
    },
    getConsciousModeEnabled: () => {
      calls.push('getConscious');
      return false;
    },
    setAccelerationModeEnabled: (enabled: boolean) => {
      calls.push(`setAcceleration:${enabled}`);
      return true;
    },
    getAccelerationModeEnabled: () => {
      calls.push('getAcceleration');
      return true;
    },
    setDisguise: (mode: 'terminal' | 'settings' | 'activity' | 'none') => {
      calls.push(`setDisguise:${mode}`);
    },
    getDisguise: () => {
      calls.push('getDisguise');
      return 'activity';
    },
    getUndetectable: () => {
      calls.push('getUndetectable');
      return true;
    },
  });

  assert.equal(facade.setConsciousModeEnabled(true), true);
  assert.equal(facade.getConsciousModeEnabled(), false);
  assert.equal(facade.setAccelerationModeEnabled(false), true);
  assert.equal(facade.getAccelerationModeEnabled(), true);
  facade.setDisguise('terminal');
  assert.equal(facade.getDisguise(), 'activity');
  assert.equal(facade.getUndetectable(), true);

  assert.deepEqual(calls, [
    'setConscious:true',
    'getConscious',
    'setAcceleration:false',
    'getAcceleration',
    'setDisguise:terminal',
    'getDisguise',
    'getUndetectable',
  ]);
});
