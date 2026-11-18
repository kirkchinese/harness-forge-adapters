// Build or check index.json, the DSH plugin market index (format 1) of this
// repository: every adapter version is installed from this repository at one
// commit. DSH's own validator checks the document either way.
//
//   node scripts/build-index.mjs --commit <40-hex sha that contains the adapters>
//   node scripts/build-index.mjs --check
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'

const args = process.argv.slice(2)
const option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined }
const repository = 'https://github.com/kirkchinese/harness-forge-adapters'
const indexUrl = 'https://raw.githubusercontent.com/kirkchinese/harness-forge-adapters/main/index.json'
const root = fileURLToPath(new URL('..', import.meta.url))
const adapters = join(root, 'adapters')

if (args.includes('--check')) {
  const index = parseMarketIndex(JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')), indexUrl)
  const listed = new Set(index.plugins.map(plugin => plugin.name))
  const present = readdirSync(adapters).filter(name => statSync(join(adapters, name)).isDirectory()).map(name => JSON.parse(readFileSync(join(adapters, name, 'package.json'), 'utf8')))
  const missing = present.filter(manifest => !listed.has(manifest.name)).map(manifest => manifest.name)
  const stale = present.filter(manifest => index.plugins.find(plugin => plugin.name === manifest.name)?.versions.every(version => version.version !== manifest.version)).map(manifest => manifest.name)
  if (missing.length > 0 || stale.length > 0) throw new Error(`index.json is behind the adapters: missing ${missing.join(', ') || 'none'}; version not listed for ${stale.join(', ') || 'none'}`)
  console.log(`index.json is valid and lists ${String(index.plugins.length)} adapter(s)`)
  process.exit(0)
}

const commit = option('--commit')
if (commit === undefined || !/^[0-9a-f]{40}$/u.test(commit)) throw new Error('--commit <40-hex lowercase sha> is required')
const sources = { 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode' }
const plugins = readdirSync(adapters).filter(name => statSync(join(adapters, name)).isDirectory()).sort().map((name) => {
  const dir = join(adapters, name)
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const port = existsSync(join(dir, 'port.json')) ? JSON.parse(readFileSync(join(dir, 'port.json'), 'utf8')) : {}
  const published = Math.floor(Date.parse(port.publishedAt ?? port.createdAt ?? new Date().toISOString()) / 1000)
  const source = port.gap?.plugin?.source
  return {
    name: manifest.name,
    title: manifest.description,
    description: `${port.gap?.plugin?.name ?? name} (${sources[source] ?? source ?? 'plugin'}) for DSH. Ported in Harness Forge's porting studio.`,
    author: 'kirkchinese',
    homepage: `${repository}/tree/main/adapters/${name}`,
    repository: { url: repository, directory: `adapters/${name}` },
    metadata: { category: 'adapter', keywords: manifest.keywords ?? [], labels: source === undefined ? [] : [source] },
    versions: [{
      version: manifest.version,
      publishTimestamp: published,
      source: { type: 'git', url: repository, commit, path: `adapters/${name}` },
      engines: manifest.engines?.dsh === undefined ? {} : { dsh: manifest.engines.dsh },
    }],
  }
})
const labels = Object.fromEntries([...new Set(plugins.flatMap(plugin => plugin.metadata.labels))].map(id => [id, { title: sources[id] ?? id }]))
const index = {
  format: 1,
  title: { en: 'Harness Forge adapters', zh: 'Harness Forge 适配器' },
  description: { en: 'Claude Code, Codex and OpenCode plugin parts brought to DSH by its porting studio.', zh: '由移植工作室带进 DSH 的 Claude Code、Codex、OpenCode 插件部件。' },
  metadata: { categories: { adapter: { title: { en: 'Adapters', zh: '适配器' } } }, labels },
  plugins,
}
const parsed = parseMarketIndex(JSON.parse(JSON.stringify(index)), indexUrl)
writeFileSync(join(root, 'index.json'), `${JSON.stringify(index, null, 2)}\n`)
console.log(`index.json: ${String(parsed.plugins.length)} adapter(s) at ${commit.slice(0, 12)}, valid`)