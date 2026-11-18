// Loads the client bundle the way the browser does, enough to reach its pure
// exports, without a real React. Used by the tests that exercise ANSI → spans
// and the session poll state.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function loadClient() {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js'), 'utf8')
  let definition
  globalThis.window = globalThis
  globalThis.window.__ModuleLoader__ = { load: (loaded) => { definition = loaded } }
  // The file's top level is the single `window.__ModuleLoader__.load({...})` expression.
  new Function(source)()
  if (definition === undefined) throw new Error('client.js did not call window.__ModuleLoader__.load')
  const react = { createElement: (type, props, ...children) => ({ type, props, children }) }
  return definition.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require(${name})`)
  })
}
