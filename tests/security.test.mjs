import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const mainPath = new URL('../src/main/index.ts', import.meta.url)
const mainSource = await readFile(mainPath, 'utf8')
const sourceFile = ts.createSourceFile(
  mainPath.pathname,
  mainSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS
)

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text
  return null
}

function objectProperty(object, name) {
  return object.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) &&
      propertyName(property.name) === name
  )
}

function booleanProperty(object, name, expected) {
  const property = objectProperty(object, name)

  assert.ok(property, `BrowserWindow webPreferences must define ${name}`)
  assert.ok(
    ts.isPropertyAssignment(property),
    `BrowserWindow ${name} must be a property assignment`
  )

  const initializer = property.initializer

  assert.equal(
    initializer.kind,
    expected ? ts.SyntaxKind.TrueKeyword : ts.SyntaxKind.FalseKeyword,
    `BrowserWindow ${name} must be ${expected}`
  )
}

function findFunction(name) {
  let result = null

  function visit(node) {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === name
    ) {
      result = node
      return
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  assert.ok(result, `Expected function ${name}()`)
  return result
}

function callExpressionsNamed(name) {
  const results = []

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      results.push(node)
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return results
}

test('every BrowserWindow keeps the hardened Electron security baseline', () => {
  const windows = []

  function visit(node) {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'BrowserWindow'
    ) {
      windows.push(node)
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  assert.ok(windows.length > 0, 'Expected at least one BrowserWindow')

  for (const window of windows) {
    const options = window.arguments?.[0]

    assert.ok(
      options && ts.isObjectLiteralExpression(options),
      'BrowserWindow must use an inline options object'
    )

    const webPreferencesProperty = objectProperty(options, 'webPreferences')

    assert.ok(
      webPreferencesProperty &&
        ts.isPropertyAssignment(webPreferencesProperty) &&
        ts.isObjectLiteralExpression(webPreferencesProperty.initializer),
      'BrowserWindow must define inline webPreferences'
    )

    const webPreferences = webPreferencesProperty.initializer

    booleanProperty(webPreferences, 'contextIsolation', true)
    booleanProperty(webPreferences, 'nodeIntegration', false)
    booleanProperty(webPreferences, 'sandbox', true)
  }
})

test('external URL handling is allowlisted and centralized', () => {
  const helper = findFunction('openExternalWebUrl')
  const text = helper.getText(sourceFile)

  assert.match(
    text,
    /new URL\(rawUrl\)/,
    'External URL helper must parse the supplied URL'
  )

  assert.match(
    text,
    /url\.protocol !== 'http:' && url\.protocol !== 'https:'/,
    'Only HTTP and HTTPS external URLs may be allowed'
  )

  assert.match(
    text,
    /shell\.openExternal\(url\.toString\(\)\)/,
    'Allowed external URLs must use the normalized parsed URL'
  )

  const externalOpenCalls = []

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'shell' &&
      node.expression.name.text === 'openExternal'
    ) {
      externalOpenCalls.push(node)
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  assert.equal(
    externalOpenCalls.length,
    1,
    'shell.openExternal must remain centralized in openExternalWebUrl()'
  )

  assert.ok(
    externalOpenCalls[0].getStart(sourceFile) >= helper.getStart(sourceFile) &&
      externalOpenCalls[0].getEnd() <= helper.getEnd(),
    'shell.openExternal must only be called inside openExternalWebUrl()'
  )
})

test('privileged renderer windows share one deny-in-app navigation policy', () => {
  const policy = findFunction('installRendererNavigationPolicy')
  const text = policy.getText(sourceFile)

  assert.match(
    text,
    /setWindowOpenHandler/,
    'Navigation policy must own new-window requests'
  )

  assert.match(
    text,
    /return \{ action: 'deny' \}/,
    'Popup requests must always be denied in-app'
  )

  assert.match(
    text,
    /['"]will-navigate['"]/,
    'Navigation policy must intercept renderer-initiated top-level navigation'
  )

  assert.match(
    text,
    /event\.preventDefault\(\)/,
    'Renderer-initiated navigation must be prevented in-app'
  )

  const externalRoutingCalls =
    text.match(/openExternalWebUrl\(url\)/g) ?? []

  assert.equal(
    externalRoutingCalls.length,
    2,
    'Popup and top-level navigation paths must both use the external URL allowlist'
  )

  const policyCalls = callExpressionsNamed('installRendererNavigationPolicy')
  const argumentsUsed = policyCalls.map((call) =>
    call.arguments[0]?.getText(sourceFile)
  )

  assert.deepEqual(
    argumentsUsed.sort(),
    ['mainWindow', 'preferencesWindow'],
    'Main and Preferences windows must both install the shared navigation policy'
  )
})
