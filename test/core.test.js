'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const hostPath = path.join(__dirname, '..', 'src', 'host.js')
const hostBody = fs.readFileSync(hostPath, 'utf8')

test('host.js parses as a function body (DSH precheck parity)', () => {
  assert.doesNotThrow(() => new Function(`(async () => {\n${hostBody}\n})()`))
})

test('host.js evaluates to a plugin in a non-sandbox environment (static mount)', () => {
  const plugin = new Function(hostBody)()
  assert.equal(typeof plugin, 'object')
  assert.equal(typeof plugin.apply, 'function')
})

const PURE_START = '\n//PURE-CORE-START'
const PURE_END = '\n//PURE-CORE-END'
const startIdx = hostBody.indexOf(PURE_START)
const endIdx = hostBody.indexOf(PURE_END)
assert.ok(startIdx >= 0 && endIdx > startIdx, 'pure-core markers present')
const pureSection = hostBody.slice(startIdx + 1, endIdx + PURE_END.length)
const core = new Function(`${pureSection}\n; return fffCore`)()

const { fuzzyScore, scorePath, rankPaths, resolveBest, relatedPaths, groupSearchResults } = core

// ── fuzzyScore ────────────────────────────────────────────────────────────
test('fuzzyScore: exact substring and prefix rank high', () => {
  const exact = fuzzyScore('main', 'main.ts')
  const sub = fuzzyScore('ain', 'main.ts')
  const none = fuzzyScore('xyz', 'main.ts')
  assert.ok(exact > sub)
  assert.equal(none, -1)
  assert.equal(fuzzyScore('', 'anything'), 0)
  assert.equal(fuzzyScore('longer-than-candidate', 'abc'), -1)
})

test('fuzzyScore: subsequence matching works case-insensitively', () => {
  assert.ok(fuzzyScore('mn', 'Main.ts') > 0)
  assert.equal(fuzzyScore('mtn', 'main.ts'), -1) // wrong order
})

test('fuzzyScore: contiguous runs score higher than scattered', () => {
  const contiguous = fuzzyScore('main', 'maintenance.ts')
  const scattered = fuzzyScore('mti', 'maintenance.ts')
  assert.ok(contiguous > scattered)
})

// ── scorePath / rankPaths ─────────────────────────────────────────────────
test('scorePath prefers basename matches over directory matches', () => {
  const base = scorePath('util', 'src/app/util.ts')
  const dir = scorePath('util', 'src/util/app.ts')
  assert.ok(base > dir)
  assert.equal(scorePath('zzz', 'apps/notes/api.ts'), -1)
})

test('scorePath splits multi-token queries (fzf style); every token must match', () => {
  const hit = scorePath('rtk host', 'dsh-rtk-optimizer/src/host.js')
  assert.ok(hit > 0)
  // both tokens must match: 'rtk' matches the dir, 'host' the basename
  assert.equal(scorePath('rtk nope', 'dsh-rtk-optimizer/src/host.js'), -1)
  // same-token equivalence with the single-token path
  assert.equal(scorePath('util', 'src/app/util.ts'), scorePath(' util ', 'src/app/util.ts'))
})

test('rankPaths sorts by score and caps at limit', () => {
  const paths = ['src/app/main.ts', 'apps/notes/api.ts', 'src/app/util.ts', 'README.md']
  const ranked = rankPaths('app', paths, 2)
  assert.equal(ranked.length, 2)
  assert.ok(ranked[0].score >= ranked[1].score)
  // all returned paths actually match the query
  for (const r of ranked) assert.ok(r.score > 0)
})

test('rankPaths returns everything when limit is high', () => {
  const paths = ['a/app.ts', 'b/app.ts', 'c/app.ts']
  assert.equal(rankPaths('app', paths, 10).length, 3)
})

test('resolveBest returns the single best path or undefined', () => {
  const paths = ['src/app/main.ts', 'src/app/util.ts', 'README.md']
  assert.equal(resolveBest('main', paths), 'src/app/main.ts')
  assert.equal(resolveBest('readme', paths), 'README.md')
  assert.equal(resolveBest('nonexistent', paths), undefined)
})

// ── relatedPaths ──────────────────────────────────────────────────────────
test('relatedPaths finds same-stem, same-dir, and sibling files', () => {
  const paths = [
    'src/app/main.ts',
    'src/app/main.test.ts',
    'src/app/util.ts',
    'src/app/main.spec.ts',
    'src/other/api.ts',
    'README.md'
  ]
  const related = relatedPaths('src/app/main.ts', paths, 10)
  // same-stem variants first
  assert.ok(related.includes('src/app/main.test.ts'))
  assert.ok(related.includes('src/app/main.spec.ts'))
  assert.ok(related.includes('src/app/util.ts'))
  assert.ok(!related.includes('src/app/main.ts')) // never itself
  // ordering: same stem before same dir
  assert.ok(related.indexOf('src/app/main.test.ts') < related.indexOf('src/app/util.ts'))
})

test('relatedPaths respects the limit and handles root files', () => {
  const paths = ['a.ts', 'b.ts', 'c.ts', 'README.md']
  const related = relatedPaths('README.md', paths, 2)
  assert.ok(related.length <= 2)
  assert.ok(!related.includes('README.md'))
})

// ── groupSearchResults ────────────────────────────────────────────────────
test('groupSearchResults groups rg-style rows by file with counts', () => {
  const input = [
    'src/a.ts:3:foo',
    'src/a.ts:9:foo',
    'src/b.ts:1:bar',
    '2 files inspected'
  ].join('\n')
  const out = groupSearchResults(input)
  assert.match(out, /src\/a\.ts \(2 matches\)/)
  assert.match(out, /src\/b\.ts \(1 match\)/)
  assert.match(out, /2 files inspected/)
})

test('groupSearchResults passes non-search output through unchanged', () => {
  const input = 'plain output\nno structure here\n'
  assert.equal(groupSearchResults(input), input)
})

// ── plugin surface sanity ─────────────────────────────────────────────────
test('plugin registers the four fff tools', () => {
  const plugin = new Function(hostBody)()
  const registered = []
  const tools = []
  const ctx = {
    get: (name) => {
      if (name === 'fs') return {}
      if (name === 'systemPrompt') return { section: () => {} }
      if (name === 'subprocess') return {}
      return undefined
    },
    on: () => () => {},
    provide: () => () => {}
  }
  // monkey-patch registerTool through the closure? Instead: intercept ctx.tools
  // by providing a tools object whose register records definitions.
  const fakeCtx = {
    get: (name) => {
      if (name === 'fs') return {}
      if (name === 'systemPrompt') return { section: () => {} }
      if (name === 'subprocess') return {}
      return undefined
    },
    on: () => () => {},
    provide: () => () => {},
    tools: { register: (tool) => { tools.push(tool); return () => {} } }
  }
  plugin.apply(fakeCtx)
  const names = tools.map((t) => t.name).sort()
  assert.deepEqual(names, ['fff_grep', 'find_files', 'related_files', 'resolve_file'])
})
