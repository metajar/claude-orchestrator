import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FleetSession, Line, OrchView } from '../types'

// The orchestrator's view of its project: the fleet agent-manager runs, the
// shared task list, file reservations, and the .orchestrator/ ledger,
// decisions and plans. Read-only: it never sends, kills or archives.

const PANE = 'orchestrator-view'
const TITLE = 'Orchestrator'
const POLL_MS = 5000

const EMPTY: OrchView = {
  isActive: false,
  checkedAt: 0,
  root: '',
  sessions: [],
  archivedCount: 0,
  tasks: [],
  reservations: [],
  hasStateDir: false,
  plans: [],
}

const view = atom({ plugin: 'orchestrator', key: 'view' } as const, EMPTY, {
  shape: 'orch-view-1',
})

const isOrchestratorSkill = (skill: string) => /(^|:)orchestrator$/.test(skill)

// ---------- reading the world ----------

type Run = { ok: true; stdout: string } | { ok: false; error: string }

const run = async ($: EngineInterface, argv: string[], cwd?: string): Promise<Run> => {
  try {
    const r = await $.process.run(argv, { cwd, timeoutMs: 10_000 })
    if (r.exitCode === 0) return { ok: true, stdout: r.stdout }
    const why = (r.stderr || r.stdout).trim().split('\n')[0] ?? ''
    return { ok: false, error: why.replace(/^agent-manager:\s*/, '').slice(0, 160) || `exit ${r.exitCode}` }
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 160) }
  }
}

const rowsOf = (stdout: string): Record<string, unknown>[] => {
  const json: unknown = JSON.parse(stdout)
  if (Array.isArray(json)) return json as Record<string, unknown>[]
  if (json && typeof json === 'object') {
    for (const v of Object.values(json)) if (Array.isArray(v)) return v as Record<string, unknown>[]
  }
  return []
}

const str = (o: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v !== '') return v
    if (typeof v === 'number') return String(v)
  }
  return ''
}

const toneOfStatus = (s: string): Line['tone'] => {
  const x = s.toLowerCase()
  if (/err|fail/.test(x)) return 'bad'
  if (/wait|block|held/.test(x)) return 'warn'
  if (/work|run|claim|progress|active/.test(x)) return 'ok'
  if (/done|finish|dead|idle|archiv|complete/.test(x)) return 'dim'
  return 'plain'
}

const isDone = (s: string) => /done|finish|complete/i.test(s)

// The last "## " section of a markdown file, capped.
const lastSection = (text: string, maxLines: number) => {
  const lines = text.trimEnd().split('\n')
  let start = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]?.startsWith('## ')) {
      start = i
      break
    }
  }
  const part = lines.slice(start)
  return part.length > maxLines ? [...part.slice(0, maxLines), '…'].join('\n') : part.join('\n')
}

const tail = (text: string, maxLines: number) => text.trimEnd().split('\n').slice(-maxLines).join('\n')

const readIf = async ($: EngineInterface, path: string) =>
  (await $.fs.exists(path)) ? String(await $.fs.read(path)) : undefined

const collect = async ($: EngineInterface, prev: OrchView): Promise<OrchView> => {
  const next: OrchView = {
    ...EMPTY,
    sessions: [],
    tasks: [],
    reservations: [],
    plans: [],
    isActive: prev.isActive,
    checkedAt: Date.now(),
  }

  // Fleet
  const s = await run($, ['agent-manager', 'sessions', '--json'])
  let selfDir: string | undefined
  if (s.ok) {
    try {
      for (const r of rowsOf(s.stdout)) {
        if (r.archived === true) {
          next.archivedCount++
          continue
        }
        const row: FleetSession = {
          id: str(r, 'id'),
          name: str(r, 'name') || '(unnamed)',
          tool: str(r, 'tool'),
          group: str(r, 'group'),
          status: str(r, 'status') || '?',
          isSelf: r.self === true,
        }
        if (row.isSelf) {
          next.self = row
          selfDir = str(r, 'directory') || undefined
        } else next.sessions.push(row)
      }
    } catch {
      next.sessionsError = 'unreadable output from agent-manager sessions'
    }
  } else next.sessionsError = s.error

  // Project root: the orchestrator's own directory, else the git top, else cwd.
  let root = selfDir
  if (!root) {
    const g = await run($, ['git', 'rev-parse', '--show-toplevel'])
    root = g.ok ? g.stdout.trim() : await $.session.cwd()
  }
  next.root = root

  // Shared tasks (needs to run inside an Agent Manager pane)
  const t = await run($, ['agent-manager', 'task', 'list', '--json'], root)
  if (t.ok) {
    try {
      const rows = rowsOf(t.stdout)
      const open = rows.filter(r => !isDone(str(r, 'state', 'status')))
      for (const r of open) {
        const status = r.blocked === true ? 'blocked' : str(r, 'state', 'status') || 'pending'
        const owner = str(r, 'owner_name', 'owner')
        const title = str(r, 'title', 'id')
        next.tasks.push({ text: `${status.padEnd(9)} ${title}${owner ? `  ← ${owner}` : ''}`, tone: toneOfStatus(status) })
      }
      const done = rows.length - open.length
      if (done > 0) next.tasks.push({ text: `${done} done`, tone: 'dim' })
    } catch {
      next.tasksError = 'unreadable output from agent-manager task list'
    }
  } else next.tasksError = t.error

  // File reservations
  const rv = await run($, ['agent-manager', 'reservations', '--json'], root)
  if (rv.ok) {
    try {
      for (const r of rowsOf(rv.stdout)) {
        const who = str(r, 'holder', 'session_id')
        const mode = str(r, 'mode')
        const note = str(r, 'note')
        next.reservations.push({
          text: `${str(r, 'pattern', 'path')}${mode ? ` (${mode})` : ''}${who ? `  ← ${who}` : ''}${note ? ` · ${note}` : ''}`,
          tone: mode === 'exclusive' ? 'warn' : 'plain',
        })
      }
    } catch {
      next.reservationsError = 'unreadable output from agent-manager reservations'
    }
  } else next.reservationsError = rv.error

  // .orchestrator/ state on disk
  const dir = `${root}/.orchestrator`
  next.hasStateDir = await $.fs.exists(dir)
  if (next.hasStateDir) {
    if (await $.fs.exists(`${dir}/plans`)) {
      next.plans = (await $.fs.list(`${dir}/plans`))
        .filter(f => f.name.endsWith('.md'))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .map(f => f.name.replace(/\.md$/, ''))
    }
    const ledger = await readIf($, `${dir}/ledger.md`)
    if (ledger) next.ledgerTail = lastSection(ledger, 30)
    const decisions = await readIf($, `${dir}/decisions.md`)
    if (decisions) next.decisionsTail = tail(decisions, 12)
  }

  return next
}

// ---------- the step-in signals ----------

const STEP_IN = /wait|err|fail|block/i

const announce = ($: EngineInterface, prev: OrchView, now: OrchView) => {
  if (prev.checkedAt === 0) return
  const before = new Map(prev.sessions.map(s => [s.id, s.status]))
  for (const s of now.sessions) {
    const was = before.get(s.id)
    if (was !== undefined && was !== s.status && STEP_IN.test(s.status)) {
      $.ui.toast(`${s.name} is ${s.status}`)
    }
  }
}

const statusLine = (v: OrchView) => {
  if (!v.isActive) return undefined
  if (v.sessionsError) return 'orch · agent-manager unavailable'
  const count = (re: RegExp) => v.sessions.filter(s => re.test(s.status)).length
  const parts = [`${v.sessions.length} live`]
  const working = count(/work|run/i)
  const waiting = count(/wait/i)
  const errored = count(/err|fail/i)
  if (working) parts.push(`${working} working`)
  if (waiting) parts.push(`${waiting} waiting`)
  if (errored) parts.push(`${errored} errored`)
  const openTasks = v.tasks.filter(t => t.tone !== 'dim').length
  if (!v.tasksError) parts.push(`${openTasks} open tasks`)
  return `orch · ${parts.join(' · ')}`
}

// ---------- register ----------

let isBusy = false

async function refresh($: EngineInterface) {
  if (isBusy) return
  isBusy = true
  try {
    const prev = await read($, view)
    const now = await collect($, prev)
    announce($, prev, now)
    const merged = await update($, view, cur => ({ ...now, isActive: cur.isActive }))
    $.ui.status(statusLine(merged))
  } catch (err) {
    $.ui.log(`orchestrator: refresh failed: ${String(err).slice(0, 200)}`, { to: 'debug' })
  } finally {
    isBusy = false
  }
}

async function activate($: EngineInterface) {
  const v = await update($, view, cur => ({ ...cur, isActive: true }))
  $.ui.status(statusLine(v))
  await refresh($)
  await $.ui.open({ id: PANE, title: TITLE })
}

async function startupLook($: EngineInterface) {
  await refresh($)
  const v = await read($, view)
  if (v.isActive || /orchestrat/i.test(v.self?.name ?? '')) await activate($)
}

async function tick($: EngineInterface) {
  if ((await read($, view)).isActive) await refresh($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'orch-view',
      description: "Open the orchestrator's view: fleet, tasks, reservations, ledger",
    })

    // One look at startup: a session agent-manager named as the orchestrator,
    // or one that already ran the skill before a reload, turns the view on.
    void startupLook($)
    $.clock.every(POLL_MS, () => void tick($))

    return started
  })

  // The orchestrator skill starting is the signal this session is the orchestrator.
  on('skill.prompt', async ($, e, next) => {
    if (isOrchestratorSkill(e.skill)) void activate($)
    return next(e)
  })

  on('command.run', { command: 'orch-view' }, async $ => {
    await activate($)
    return { text: "Orchestrator view opened." }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Markdown } = $.ui.resolve(e)
    const v = await read($, view)
    const width = Math.max(20, e.props.bodyColumns)
    const fit = (s: string) => (s.length > width ? `${s.slice(0, width - 1)}…` : s)
    const colorOf = (tone: Line['tone']) =>
      tone === 'ok' ? 'success' : tone === 'warn' ? 'warning' : tone === 'bad' ? 'error' : undefined
    const line = (l: Line) => (
      <Text color={colorOf(l.tone)} dimColor={l.tone === 'dim'}>
        {fit(l.text)}
      </Text>
    )
    const heading = (s: string) => <Text bold>{s}</Text>
    const gap = <Text> </Text>

    if (v.checkedAt === 0) return <Text dimColor>Reading the fleet…</Text>

    const fleet = [...v.sessions].sort((a, b) => {
      const rank = (s: FleetSession) => (/err|fail/i.test(s.status) ? 0 : /wait/i.test(s.status) ? 1 : /work|run/i.test(s.status) ? 2 : 3)
      return rank(a) - rank(b) || a.name.localeCompare(b.name)
    })

    return (
      <Box flexDirection="column">
        {v.self ? (
          <Text bold color="claude">{fit(`${v.self.name}  (${v.self.id})`)}</Text>
        ) : (
          <Text dimColor>{fit('This session is not inside Agent Manager')}</Text>
        )}
        <Text dimColor>{fit(v.root)}</Text>
        {gap}

        {heading(`Fleet · ${v.sessions.length} live${v.archivedCount ? ` · ${v.archivedCount} archived` : ''}`)}
        {v.sessionsError && <Text color="error">{fit(`unavailable: ${v.sessionsError}`)}</Text>}
        {!v.sessionsError && fleet.length === 0 && <Text dimColor>No live agents.</Text>}
        {fleet.map(s =>
          line({
            text: `${s.status.padEnd(8)} ${s.name}${s.tool ? ` · ${s.tool}` : ''}${s.group ? ` · ${s.group}` : ''}`,
            tone: toneOfStatus(s.status),
          }),
        )}
        {gap}

        {heading('Tasks')}
        {v.tasksError && <Text dimColor>{fit(`unavailable: ${v.tasksError}`)}</Text>}
        {!v.tasksError && v.tasks.length === 0 && <Text dimColor>No tasks.</Text>}
        {v.tasks.map(line)}

        {(v.reservations.length > 0 || v.reservationsError) && gap}
        {(v.reservations.length > 0 || v.reservationsError) && heading('Reservations')}
        {v.reservationsError && <Text dimColor>{fit(`unavailable: ${v.reservationsError}`)}</Text>}
        {v.reservations.map(line)}

        {gap}
        {heading(`Plans${v.plans.length ? ` · ${v.plans.length}` : ''}`)}
        {!v.hasStateDir && <Text dimColor>No .orchestrator/ in this project yet.</Text>}
        {v.hasStateDir && v.plans.length === 0 && <Text dimColor>None.</Text>}
        {v.plans.slice(0, 8).map(p => <Text>{fit(`• ${p}`)}</Text>)}

        {v.decisionsTail && gap}
        {v.decisionsTail && heading('Recent decisions')}
        {v.decisionsTail && <Markdown text={v.decisionsTail} />}

        {v.ledgerTail && gap}
        {v.ledgerTail && heading('Ledger · latest')}
        {v.ledgerTail && <Markdown text={v.ledgerTail} />}

        {gap}
        <Text dimColor>{`updated ${new Date(v.checkedAt).toLocaleTimeString()}`}</Text>
      </Box>
    )
  })
}
