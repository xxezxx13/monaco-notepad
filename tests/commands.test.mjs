/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const commandsPath = fileURLToPath(new URL('../src/shared/commands.ts', import.meta.url))
const menuPath = fileURLToPath(new URL('../src/main/menu.ts', import.meta.url))
const rendererPath = fileURLToPath(new URL('../src/renderer/src/renderer.ts', import.meta.url))
const preloadPath = fileURLToPath(new URL('../src/preload/index.ts', import.meta.url))

const commandsSource = await readFile(commandsPath, 'utf8')
const module = { exports: {} }

vm.runInNewContext(
  ts.transpileModule(commandsSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS }
  }).outputText,
  {
    module,
    exports: module.exports,
    Set,
    Error
  }
)

const {
  MENU_COMMAND_IDS,
  SHORTCUT_DEFINITIONS,
  KEYBOARD_SHORTCUTS,
  getShortcutDefinition,
  shortcutDisplayAccelerator
} = module.exports

const plain = (value) => JSON.parse(JSON.stringify(value))

test('command and shortcut registries are unique and internally consistent', () => {
  assert.equal(new Set(MENU_COMMAND_IDS).size, MENU_COMMAND_IDS.length)
  assert.equal(SHORTCUT_DEFINITIONS.length, 28)

  const shortcutIds = SHORTCUT_DEFINITIONS.map(({ id }) => id)
  assert.equal(new Set(shortcutIds).size, shortcutIds.length)

  const validIds = new Set([...MENU_COMMAND_IDS, 'show-line-numbers', 'full-screen'])

  for (const shortcut of SHORTCUT_DEFINITIONS) {
    assert.ok(validIds.has(shortcut.id), `Unknown shortcut command id: ${shortcut.id}`)
    assert.equal(getShortcutDefinition(shortcut.id).accelerator, shortcut.accelerator)
  }

  assert.deepEqual(
    plain(KEYBOARD_SHORTCUTS),
    plain(
      SHORTCUT_DEFINITIONS.map(({ label, accelerator }) => ({
        label,
        accelerator: shortcutDisplayAccelerator(accelerator)
      }))
    )
  )
})

test('drag and drop reuses the guarded open-file pipeline', async () => {
  const [rendererSource, preloadSource] = await Promise.all([
    readFile(rendererPath, 'utf8'),
    readFile(preloadPath, 'utf8')
  ])

  const dragoverBlock = `window.addEventListener('dragover', (event) => {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
})`

  const dropBlock = `window.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files[0]
  if (!file) return

  event.preventDefault()
  const filePath = window.api.getPathForFile(file)
  if (filePath) runDocumentAction(() => openFile(filePath))
})`

  assert.equal(
    rendererSource.split("window.addEventListener('dragover'").length - 1,
    1,
    'Renderer must have exactly one file dragover owner'
  )
  assert.equal(
    rendererSource.split("window.addEventListener('drop'").length - 1,
    1,
    'Renderer must have exactly one file drop owner'
  )
  assert.ok(rendererSource.includes(dragoverBlock))
  assert.ok(rendererSource.includes(dropBlock))

  assert.ok(
    preloadSource.includes('getPathForFile: (file: File): string => webUtils.getPathForFile(file)'),
    'Dropped File objects must be resolved through Electron webUtils'
  )

  assert.match(
    rendererSource,
    /async function openFile\([\s\S]*?if \(!\(await confirmUnsavedChanges\(\)\)\) \{[\s\S]*?window\.api\.openFilePath\(filePath, bomlessEncoding, requestId\)/,
    'Dropped files must retain dirty-buffer confirmation and the normal openFilePath IPC pipeline'
  )

  assert.doesNotMatch(
    dropBlock,
    /readFile|openFilePath|ipcRenderer|fs\./,
    'Drop handling must not create a parallel file-reading or IPC path'
  )
})

test('native menu consumes every canonical shortcut exactly once without literal accelerators', async () => {
  const menuSource = await readFile(menuPath, 'utf8')
  const sourceFile = ts.createSourceFile(
    menuPath,
    menuSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )

  const consumerIds = []
  const malformedConsumers = []
  const acceleratorInitializers = []

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'shortcutMenuProperties'
    ) {
      if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) {
        malformedConsumers.push(node.getText(sourceFile))
      } else {
        consumerIds.push(node.arguments[0].text)
      }
    }

    if (
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === 'accelerator') ||
        (ts.isStringLiteral(node.name) && node.name.text === 'accelerator'))
    ) {
      acceleratorInitializers.push(node.initializer.getText(sourceFile))
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  const shortcutIds = SHORTCUT_DEFINITIONS.map(({ id }) => id)

  assert.deepEqual(malformedConsumers, [])
  assert.equal(consumerIds.length, shortcutIds.length)
  assert.equal(new Set(consumerIds).size, consumerIds.length)
  assert.deepEqual([...consumerIds].sort(), [...shortcutIds].sort())

  assert.deepEqual(
    acceleratorInitializers,
    ['shortcut.accelerator'],
    'Native menu accelerator values must come only from the canonical registry helper'
  )
})
