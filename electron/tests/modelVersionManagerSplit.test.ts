import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'

const SERVICES_DIR = path.join(process.cwd(), 'electron', 'services')

test('NAT-067: ModelVersionManager split modules exist', () => {
  const modules = [
    'modelVersionTypes.ts',
    'modelVersionUtils.ts',
    'modelVersionPersistence.ts',
    'modelVersionTierUpgrade.ts',
    'modelVersionProviderDiscovery.ts',
    'ModelVersionManager.ts',
  ]
  for (const mod of modules) {
    const modPath = path.join(SERVICES_DIR, mod)
    assert.ok(fs.existsSync(modPath), `${mod} should exist`)
    const stat = fs.statSync(modPath)
    assert.ok(stat.size > 0, `${mod} should be non-empty`)
  }
})

test('NAT-067: ModelVersionManager.ts barrel re-exports types and utils', () => {
  const source = fs.readFileSync(path.join(SERVICES_DIR, 'ModelVersionManager.ts'), 'utf8')
  assert.ok(source.includes("export { ModelVersion, ModelFamily, TextModelFamily, TieredModels } from './modelVersionTypes'"), 'should re-export types')
  assert.ok(source.includes("export { parseModelVersion, compareVersions, versionDistance, classifyModel, classifyTextModel } from './modelVersionUtils'"), 'should re-export utils')
})

test('NAT-067: modelVersionTypes.ts has no Electron app dependency', () => {
  const source = fs.readFileSync(path.join(SERVICES_DIR, 'modelVersionTypes.ts'), 'utf8')
  assert.ok(!source.includes("import { app }"), 'types should not import Electron app')
})

test('NAT-067: modelVersionUtils.ts imports from modelVersionTypes', () => {
  const source = fs.readFileSync(path.join(SERVICES_DIR, 'modelVersionUtils.ts'), 'utf8')
  assert.ok(source.includes("from './modelVersionTypes'"), 'utils should import types')
})
