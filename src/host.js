// dsh-fff — Host half.
// ============================================================================
// ONE self-contained JavaScript FUNCTION BODY, evaluated by DSH as
// `(async () => { <this file> })()`. It doubles as the `code.host` source for
// cordis_define AND as the static-mount body loaded by index.js (the
// environment-adaptation layer below switches between the sandbox `harness`
// and a local staticDefineTool, exactly like dsh-hashline-edit-pro).
//
// Port of pi-fff (denisshepelin; FFF = fast fuzzy finder) for the Pi coding
// agent. The Pi original rides the native `@ff-labs/fff-node` index; dynamic
// DSH plugins cannot require npm packages, so the index here is a pure-JS
// path walk with subsequence scoring — no native dependencies, works for
// source-sized projects.
//
// Registered model tools:
//   • find_files     — fuzzy path search over the session workspace
//   • resolve_file   — resolve a fuzzy reference to one exact path
//   • related_files  — files near a path (same dir / same stem / siblings)
//   • fff_grep       — ripgrep-backed content search with grouped results
// ============================================================================

//PURE-CORE-START
const MAX_INDEX_FILES = 50000
const MAX_INDEX_DEPTH = 16
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache', '__pycache__', '.venv', 'venv', '.dsh', '.idea', '.vscode'])
const MAX_QUERY_LEN = 120
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50

/**
 * Subsequence fuzzy score between query and a candidate string.
 * Higher is better; -1 means no match. Scoring favors:
 *   • exact substring          (bonus)
 *   • prefix matches           (bonus)
 *   • contiguous runs          (bonus per run + per char)
 *   • earlier match positions  (small positional bonus)
 * Case-insensitive.
 */
function fuzzyScore(query, candidate) {
  if (query.length === 0) return 0
  if (query.length > candidate.length) return -1
  const q = query.toLowerCase()
  const c = candidate.toLowerCase()

  // exact substring: strong signal
  const sub = c.indexOf(q)
  if (sub !== -1) {
    let bonus = 200
    if (sub === 0) bonus += 100 // prefix
    return 1000 + bonus - sub
  }

  // subsequence scan
  let qi = 0
  let score = 0
  let run = 0
  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] === q[qi]) {
      qi++
      run++
      score += 10 + run * 4
      if (ci < 3) score += 6 - ci * 2 // positional
    } else {
      run = 0
    }
  }
  if (qi < q.length) return -1
  return score
}

/**
 * Score a full relative path against a query. The query is split into
 * whitespace tokens (fzf-style): EVERY token must match somewhere in the
 * path — the basename counts double, directory segments count half. So
 * `app cfg` finds `src/app/config.ts` before `apps/notes/api.ts`.
 */
function scorePath(query, relPath) {
  const tokens = String(query).toLowerCase().split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length === 0) return 0
  const parts = relPath.split('/')
  const base = parts[parts.length - 1]
  let total = 0
  let anyBase = false
  for (const tok of tokens) {
    const b = fuzzyScore(tok, base)
    if (b > 0) {
      total += b * 2
      anyBase = true
      continue
    }
    let best = -1
    for (let i = 0; i < parts.length - 1; i++) {
      const s = fuzzyScore(tok, parts[i])
      if (s > best) best = s
    }
    if (best === -1) return -1 // every token must match somewhere
    total += Math.floor(best / 2)
  }
  return total + (anyBase ? 50 : 0)
}

/** Rank relPaths by scorePath against query; returns [{path, score}]. */
function rankPaths(query, relPaths, limit) {
  if (query.length > MAX_QUERY_LEN) return []
  const scored = []
  for (const p of relPaths) {
    const s = scorePath(query, p)
    if (s > 0) scored.push({ path: p, score: s })
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  return scored.slice(0, Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT))
}

/** Best single-path resolution of a fuzzy query, or undefined. */
function resolveBest(query, relPaths) {
  const ranked = rankPaths(query, relPaths, 1)
  return ranked.length > 0 ? ranked[0].path : undefined
}

/**
 * Related files: same directory first, then same stem with different
 * extensions, then same-depth siblings sharing a directory segment.
 */
function relatedPaths(relPath, relPaths, limit) {
  const parts = relPath.split('/')
  const dir = parts.slice(0, -1).join('/')
  const base = parts[parts.length - 1]
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''

  const sameDir = []
  const sameStem = []
  const siblings = []
  for (const p of relPaths) {
    if (p === relPath) continue
    const pParts = p.split('/')
    const pDir = pParts.slice(0, -1).join('/')
    const pBase = pParts[pParts.length - 1]
    if (pDir === dir) {
      sameDir.push(p)
      const pDot = pBase.lastIndexOf('.')
      const pStem = pDot > 0 ? pBase.slice(0, pDot) : pBase
      if (pStem === stem && pBase !== base) sameStem.push(p)
    } else if (pParts.length === parts.length && pDir.split('/')[0] === dir.split('/')[0] && dir !== '') {
      siblings.push(p)
    }
  }
  sameDir.sort()
  sameStem.sort()
  siblings.sort()
  const out = [...sameStem, ...sameDir, ...siblings]
  const seen = new Set()
  const unique = []
  for (const p of out) {
    if (!seen.has(p)) {
      seen.add(p)
      unique.push(p)
    }
  }
  void ext
  return unique.slice(0, Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT))
}

/** Group `path:line:content` rows by file, capping rows per file. */
function groupSearchResults(text, capPerFile = 25) {
  const groups = new Map()
  const order = []
  const other = []
  for (const line of text.split('\n')) {
    const m = /^([^:]+):(\d+):(.*)$/.exec(line)
    if (m && !/^\/\//.test(m[1]) && !m[1].includes('/.git/')) {
      let g = groups.get(m[1])
      if (!g) {
        g = { count: 0, rows: [] }
        groups.set(m[1], g)
        order.push(m[1])
      }
      g.count++
      if (g.rows.length < capPerFile) g.rows.push({ line: m[2], content: m[3] })
    } else {
      other.push(line)
    }
  }
  if (groups.size === 0) return text
  const out = []
  for (const path of order) {
    const g = groups.get(path)
    out.push(`${path} (${g.count} match${g.count === 1 ? '' : 'es'})`)
    for (const row of g.rows) out.push(`  ${row.line}: ${row.content}`)
    if (g.count > g.rows.length) out.push(`  ... (+${g.count - g.rows.length} more)`)
  }
  if (other.some((l) => l.length > 0)) {
    out.push('---')
    out.push(...other)
  }
  return out.join('\n')
}

const fffCore = {
  fuzzyScore,
  scorePath,
  rankPaths,
  resolveBest,
  relatedPaths,
  groupSearchResults,
  MAX_INDEX_FILES,
  MAX_INDEX_DEPTH
}
//PURE-CORE-END

// ============================================================================
// Environment adaptation (same pattern as dsh-hashline-edit-pro)
// ============================================================================
function staticValidateAgainst(schema, value, path, violations) {
  if (schema === undefined || schema === true) return
  if (schema === false) { violations.push(`${path} is forbidden`); return }
  if (value === undefined) {
    if (schema.required === true) violations.push(`${path} is required`)
    return
  }
  const t = typeof value
  const want = schema.type
  let typeOk
  if (want === 'integer') typeOk = Number.isInteger(value)
  else if (want === 'number') typeOk = t === 'number'
  else if (want === 'string') typeOk = t === 'string'
  else if (want === 'boolean') typeOk = t === 'boolean'
  else if (want === 'null') typeOk = value === null
  else if (want === 'object') typeOk = value !== null && t === 'object' && !Array.isArray(value)
  else if (want === 'array') typeOk = Array.isArray(value)
  else typeOk = true
  if (!typeOk) { violations.push(`${path} must be of type ${want}`); return }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    violations.push(`${path} must be one of ${schema.enum.join(', ')}`)
  }
  if (want === 'object' && value !== null && t === 'object' && !Array.isArray(value)) {
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties ?? {}, key)) {
          violations.push(`${path}.${key} is not allowed`)
          break
        }
      }
    }
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
      staticValidateAgainst(prop, value[key], `${path}.${key}`, violations)
    }
  }
  if (want === 'array' && Array.isArray(value) && schema.items !== undefined) {
    for (let i = 0; i < value.length; i++) {
      staticValidateAgainst(schema.items, value[i], `${path}[${i}]`, violations)
    }
  }
}
function staticDefineTool(options) {
  const properties = {}
  const required = []
  for (const [name, spec] of Object.entries(options.parameters ?? {})) {
    const prop = { type: spec.type }
    if (spec.description !== undefined) prop.description = spec.description
    if (spec.enum !== undefined) prop.enum = spec.enum.slice()
    if (spec.const !== undefined) prop.const = spec.const
    properties[name] = prop
    if (spec.required === true) required.push(name)
  }
  const parameters = {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {})
  }
  const outputSchema = options.output.schema
  if (outputSchema && outputSchema.type === 'object' && outputSchema.properties) {
    const outRequired = []
    const outProperties = {}
    for (const [name, prop] of Object.entries(outputSchema.properties)) {
      const copy = { ...prop }
      delete copy.required
      if (prop.required === true) outRequired.push(name)
      outProperties[name] = copy
    }
    outputSchema.properties = outProperties
    if (outRequired.length > 0) outputSchema.required = outRequired
  }
  const tool = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render: (args, value) => options.output.render(args, value)
    },
    async execute(args, exec) {
      const violations = []
      staticValidateAgainst(parameters, args, 'value', violations)
      if (violations.length > 0) throw new Error(`invalid arguments: ${violations.join('; ')}`)
      return options.execute(args, exec)
    }
  }
  if (options.isConcurrencySafe !== undefined) {
    tool.isConcurrencySafe = (args) => {
      const violations = []
      staticValidateAgainst(parameters, args, 'value', violations)
      if (violations.length > 0) return false
      return options.isConcurrencySafe(args)
    }
  }
  return tool
}
const IS_SANDBOX = typeof harness !== 'undefined' && typeof harness.defineTool === 'function'
const defineTool = IS_SANDBOX ? harness.defineTool : staticDefineTool
function registerTool(ctxRef, tool) {
  if (IS_SANDBOX) return harness.registerTool(ctxRef, tool)
  return ctxRef.tools.register(tool)
}

// ============================================================================
// Plugin
// ============================================================================
const INDEX_TTL_MS = 60000

return {
  // Hard dependencies: fs for the path walk, tools for registration,
  // systemPrompt for guidance, subprocess for ripgrep.
  inject: ['fs', 'tools', 'systemPrompt', 'subprocess'],
  apply(ctx) {
    const fs = ctx.get('fs')
    const systemPrompt = ctx.get('systemPrompt')
    const subprocess = ctx.get('subprocess')
    if (fs === undefined) throw new Error('dsh-fff: the fs service is not mounted')

    // ── In-memory index per session/process ──
    const index = {
      cwd: undefined,
      builtAt: 0,
      files: [] // relPaths
    }
    function indexFresh(cwd) {
      return index.cwd === cwd && Date.now() - index.builtAt < INDEX_TTL_MS
    }
    async function buildIndex(cwd, signal) {
      if (indexFresh(cwd)) return index.files
      const files = []
      const seenDirs = new Set()
      async function walk(dirTarget, rel, depth) {
        if (files.length >= MAX_INDEX_FILES) return
        if (depth > MAX_INDEX_DEPTH) return
        if (signal && signal.aborted === true) throw new Error('Operation aborted')
        let entries
        try {
          entries = await fs.listDir(dirTarget, signal)
        } catch (e) {
          return // unreadable dir → skip
        }
        for (const entry of entries) {
          if (signal && signal.aborted === true) throw new Error('Operation aborted')
          const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
          if (entry.type === 'directory') {
            if (SKIP_DIRS.has(entry.name)) continue
            if (seenDirs.has(childRel)) continue
            seenDirs.add(childRel)
            await walk(entry.target, childRel, depth + 1)
          } else if (entry.type === 'file') {
            files.push(childRel)
            if (files.length >= MAX_INDEX_FILES) return
          }
        }
      }
      const root = await fs.resolve('.', { cwd, signal })
      await walk(root, '', 0)
      index.cwd = cwd
      index.builtAt = Date.now()
      index.files = files
      return files
    }
    function sessionCwd(exec) {
      return exec.agent && exec.agent.session && exec.agent.session.header
        ? exec.agent.session.header.cwd
        : undefined
    }

    // ── ripgrep-backed content search ──
    async function rgSearch(cwd, pattern, relPath, glob, literal, signal, maxMatches) {
      if (subprocess === undefined) {
        throw new Error('dsh-fff: subprocess service unavailable; cannot run ripgrep')
      }
      let exe
      try {
        exe = await subprocess.resolveExecutable('rg', undefined, signal)
      } catch (e) {
        throw new Error('dsh-fff: ripgrep (rg) not found on PATH — install ripgrep for fff_grep, or use the built-in grep tool')
      }
      const argv = [exe, '--no-heading', '--line-number', '--color', 'never', '-m', String(maxMatches)]
      if (literal) argv.push('--fixed-strings')
      if (glob) argv.push('--glob', glob)
      argv.push(pattern)
      if (relPath) argv.push(relPath)
      const handle = subprocess.spawn({
        argv,
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 512 * 1024 },
          stderr: { maxBytes: 4096 }
        },
        graceMs: 300,
        signal
      })
      const outcome = await handle.done
      const reader = handle.collected && handle.collected.stdout
      const text = reader ? (await reader.readFrom(0)).text : ''
      // rg exit 1 = no matches (not an error)
      if (outcome.exitCode !== 0 && outcome.exitCode !== 1 && outcome.exitCode !== 2) {
        throw new Error(`dsh-fff: ripgrep failed with exit ${outcome.exitCode}`)
      }
      if (outcome.exitCode === 2) {
        const errReader = handle.collected && handle.collected.stderr
        const errText = errReader ? (await errReader.readFrom(0)).text.trim() : ''
        throw new Error(`dsh-fff: ripgrep error: ${errText || 'unknown'}`)
      }
      return text
    }

    // ── tool: find_files ──
    const findTool = defineTool({
      name: 'find_files',
      description: 'Fuzzy file search over the session workspace. Returns ranked paths for a vague query (e.g. "app cfg", "main"). Use before read/replace when you do not know the exact path.',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'Fuzzy query: fragments of the file name/path (spaces optional).'
        },
        limit: {
          type: 'number',
          description: `Maximum number of results. Defaults to ${DEFAULT_LIMIT}.`
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true }
          }
        },
        render: (args, value) => [{ type: 'text', text: value.text }]
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const cwd = sessionCwd(exec)
        if (cwd === undefined) throw new Error('dsh-fff: no session workspace')
        const files = await buildIndex(cwd, exec.signal)
        const ranked = rankPaths(String(args.query), files, args.limit)
        if (ranked.length === 0) {
          return { text: `No files match "${args.query}" in ${cwd}. Try a shorter or different query, or use glob/bash to explore.` }
        }
        const rows = ranked.map((r, i) => `${i + 1}. ${r.path}`)
        const note = files.length >= MAX_INDEX_FILES ? `\n[Index capped at ${MAX_INDEX_FILES} files; some paths may be missing.]` : ''
        return { text: `Top ${ranked.length} match(es) for "${args.query}":\n${rows.join('\n')}${note}` }
      }
    })
    registerTool(ctx, findTool)

    // ── tool: resolve_file ──
    const resolveTool = defineTool({
      name: 'resolve_file',
      description: 'Resolve a fuzzy file reference to one exact workspace path. Returns the best-matching path (or a ranked list when ambiguous). Feed the result directly into read / hashline_read / replace.',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'Fuzzy path reference, e.g. "src/main", "readme", "app cfg".'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true }
          }
        },
        render: (args, value) => [{ type: 'text', text: value.text }]
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const cwd = sessionCwd(exec)
        if (cwd === undefined) throw new Error('dsh-fff: no session workspace')
        const files = await buildIndex(cwd, exec.signal)
        const best = resolveBest(String(args.query), files)
        if (best === undefined) {
          return { text: `Could not resolve "${args.query}" to a file in ${cwd}. Try find_files to see candidates.` }
        }
        // show the runner-up when several are close, so ambiguity is visible
        const ranked = rankPaths(String(args.query), files, 3)
        const also = ranked.slice(1).map((r) => r.path)
        const alsoNote = also.length > 0 ? `\nAlso considered: ${also.join(', ')}` : ''
        return { text: `${best}${alsoNote}` }
      }
    })
    registerTool(ctx, resolveTool)

    // ── tool: related_files ──
    const relatedTool = defineTool({
      name: 'related_files',
      description: 'List files related to a workspace path: same stem (test/spec/impl pairs), same directory, then sibling directories. Helps find the test, fixture, or sibling module for a file.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Exact or fuzzy path of the file to expand from.'
        },
        limit: {
          type: 'number',
          description: `Maximum number of results. Defaults to ${DEFAULT_LIMIT}.`
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true }
          }
        },
        render: (args, value) => [{ type: 'text', text: value.text }]
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const cwd = sessionCwd(exec)
        if (cwd === undefined) throw new Error('dsh-fff: no session workspace')
        const files = await buildIndex(cwd, exec.signal)
        const exact = files.includes(args.path) ? args.path : resolveBest(String(args.path), files)
        if (exact === undefined) {
          return { text: `Could not resolve "${args.path}" to a file in ${cwd}. Try find_files first.` }
        }
        const related = relatedPaths(exact, files, args.limit)
        if (related.length === 0) {
          return { text: `No related files found for ${exact}.` }
        }
        return { text: `Related to ${exact}:\n${related.map((p, i) => `${i + 1}. ${p}`).join('\n')}` }
      }
    })
    registerTool(ctx, relatedTool)

    // ── tool: fff_grep ──
    const grepTool = defineTool({
      name: 'fff_grep',
      description: 'Ripgrep-backed content search returning matches grouped by file with counts. Supports a fuzzy path/folder scope and glob filters. Falls back to the built-in grep tool when ripgrep is not installed.',
      parameters: {
        pattern: {
          type: 'string',
          required: true,
          description: 'Regular expression (or literal text when literal=true) to search for.'
        },
        path: {
          type: 'string',
          description: 'Optional fuzzy path or folder scope (resolved with the same fuzzy matching as resolve_file).'
        },
        glob: {
          type: 'string',
          description: 'Optional ripgrep glob filter, e.g. "*.ts" or "!**/*.test.ts".'
        },
        literal: {
          type: 'boolean',
          description: 'Treat pattern as a fixed string instead of a regex. Defaults to false.'
        },
        limit: {
          type: 'number',
          description: 'Maximum matches per file (passed to rg -m). Defaults to 50.'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true }
          }
        },
        render: (args, value) => [{ type: 'text', text: value.text }]
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const cwd = sessionCwd(exec)
        if (cwd === undefined) throw new Error('dsh-fff: no session workspace')
        const pattern = String(args.pattern)
        let scope
        if (args.path !== undefined && String(args.path).trim() !== '') {
          const files = await buildIndex(cwd, exec.signal)
          scope = resolveBest(String(args.path), files)
          if (scope === undefined) {
            return { text: `Could not resolve scope "${args.path}" to a file; searched from the workspace root instead.` }
          }
        }
        const raw = await rgSearch(cwd, pattern, scope, args.glob, args.literal === true, exec.signal, args.limit ?? 50)
        const grouped = groupSearchResults(raw)
        const header = scope ? `Matches for ${JSON.stringify(pattern)} in ${scope}:\n\n` : `Matches for ${JSON.stringify(pattern)} in ${cwd}:\n\n`
        return { text: raw.trim() === '' ? `No matches for ${JSON.stringify(pattern)}.` : `${header}${grouped}` }
      }
    })
    registerTool(ctx, grepTool)

    // ── system prompt guidance ──
    if (systemPrompt !== undefined) {
      systemPrompt.section({
        name: 'tool:fff',
        order: 140,
        text: 'Fuzzy file tools are available: find_files (ranked path search), resolve_file (fuzzy → exact path), related_files (test/fixture/sibling discovery), fff_grep (ripgrep content search with grouped results). When a path is vague, resolve it with resolve_file before read/hashline_read/replace instead of guessing.'
      })
    }

    console.log('dsh-fff: find_files / resolve_file / related_files / fff_grep registered')
  }
}
