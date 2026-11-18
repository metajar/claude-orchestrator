import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'orchestrator',
  component: 'Pane',
  requestId: 'orchestrator-view',
  props: {
    title: 'Orchestrator',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const RUN = { command: 'orch-view', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as const

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

const SESSIONS = JSON.stringify([
  { id: 'aaaa1111', name: 'orchestrator: myapp', tool: 'claude', group: 'myapp', status: 'working', archived: false, self: true, directory: '/repo' },
  { id: 'bbbb2222', name: 'lead: auth', tool: 'claude', group: 'myapp/auth', status: 'waiting', archived: false, self: false },
  { id: 'cccc3333', name: 'coder: unit-1', tool: 'pi', group: 'myapp/auth', status: 'working', archived: false, self: false },
  { id: 'dddd4444', name: 'old persona', tool: 'claude', group: '', status: 'dead', archived: true, self: false },
])

type Fleet = { sessions?: string; tasks?: string; files?: Record<string, string>; opened?: number; toasts?: string[] }

// Stands in for agent-manager, git and the disk.
const world = (on: Parameters<TestBody>[1], fleet: Fleet) => {
  const files = fleet.files ?? {}
  const dirs = new Set(Object.keys(files).map(p => p.slice(0, p.lastIndexOf('/'))))
  dirs.add('/repo/.orchestrator')
  const hasDir = Object.keys(files).length > 0

  on('process.run', (_, e) => {
    const cmd = e.argv.join(' ')
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const fail = (stderr: string) => ({ value: { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    if (cmd === 'agent-manager sessions --json') return fleet.sessions ? ok(fleet.sessions) : fail('agent-manager: command not found')
    if (cmd === 'agent-manager task list --json') return fleet.tasks ? ok(fleet.tasks) : fail('agent-manager: not inside an Agent Manager session or terminal')
    if (cmd === 'agent-manager reservations --json') return ok('[]')
    if (cmd === 'git rev-parse --show-toplevel') return ok('/repo\n')
    return fail('unexpected')
  })
  on('fs.exists', (_, e) => ({ value: e.path in files || (hasDir && dirs.has(e.path)) }))
  on('fs.read', (_, e) => ({ value: files[e.path] ?? '' }))
  on('fs.list', (_, e) => ({
    value: Object.keys(files)
      .filter(p => p.startsWith(`${e.path}/`))
      .map(p => ({ name: p.slice(e.path!.length + 1), kind: 'file', size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('command.register', () => ({ value: { command: 'orch-view' } }))
  on('ui.open', () => {
    fleet.opened = (fleet.opened ?? 0) + 1
    return { value: { isPlaced: true } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    ;(fleet.toasts ??= []).push(e.text)
    return { value: undefined }
  })
  return fleet
}

test('the pane shows the fleet, tasks, plans and ledger', async ($, on) => {
  world(on, {
    sessions: SESSIONS,
    tasks: JSON.stringify([
      { id: 't1', title: 'AUTH-1 token refresh', state: 'in_progress', owner: 'bbbb2222', owner_name: 'lead: auth', blocked: false },
      { id: 't2', title: 'AUTH-2 docs', state: 'done', blocked: false },
      { id: 't3', title: 'AUTH-3 verify', state: 'pending', blocked: true, blocked_by: ['t1'] },
    ]),
    files: {
      '/repo/.orchestrator/ledger.md': '# Ledger\n\n## old\nold stuff\n\n## auth round\nLead: lead-auth\n',
      '/repo/.orchestrator/plans/auth.md': '# plan',
      '/repo/.orchestrator/decisions.md': '- picked option A because reversible\n',
    },
  })
  await $.command.run(RUN)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /orchestrator: myapp/ }))?.text).toBe('orchestrator: myapp  (aaaa1111)')
    expect((await ui.find({ type: 'Text', text: /Fleet/ }))?.text).toBe('Fleet · 2 live · 1 archived')
    expect((await ui.find({ type: 'Text', text: /lead: auth ·/ }))?.text).toContain('waiting')
    expect((await ui.find({ type: 'Text', text: /AUTH-1/ }))?.text).toContain('← lead: auth')
    expect((await ui.find({ type: 'Text', text: /1 done/ }))?.text).toBe('1 done')
    expect((await ui.find({ type: 'Text', text: /AUTH-3/ }))?.text).toContain('blocked')
    expect((await ui.find({ type: 'Text', text: /• auth/ }))?.text).toBe('• auth')
    expect(await ui.find({ type: 'Text', text: /Ledger · latest/ })).toBeDefined()
    await ui.unmount()
  }
})

test('agent-manager missing and no .orchestrator: the pane says so', async ($, on) => {
  world(on, {})
  await $.command.run(RUN)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /not inside Agent Manager/ }))?.text).toBe('This session is not inside Agent Manager')
    expect((await ui.find({ type: 'Text', text: /command not found/ }))?.text).toContain('unavailable')
    expect((await ui.find({ type: 'Text', text: /No .orchestrator/ }))?.text).toBe('No .orchestrator/ in this project yet.')
    await ui.unmount()
  }
})

test('before the first read the pane waits', async ($, on) => {
  world(on, {})
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('Reading the fleet…')
  await ui.unmount()
})

test('the orchestrator skill opens the view and passes its text through', async ($, on) => {
  const fleet = world(on, { sessions: SESSIONS })
  const clock = mock.clock(on)
  on('skill.prompt', (_, e) => ({ text: e.text }))
  const out = await $.skill.prompt({ skill: 'anthropic-skills:orchestrator', text: 'You are the orchestrator.' })
  expect(out.text).toBe('You are the orchestrator.')
  await clock.settle()
  expect(fleet.opened ?? 0).toBeGreaterThan(0)
})

test('another skill leaves the view closed', async ($, on) => {
  const fleet = world(on, { sessions: SESSIONS })
  on('skill.prompt', (_, e) => ({ text: e.text }))
  await $.skill.prompt({ skill: 'commit', text: 'x' })
  expect(fleet.opened ?? 0).toBe(0)
})

test('a session agent-manager names as the orchestrator opens the view at start', async ($, on) => {
  const fleet = world(on, { sessions: SESSIONS })
  const clock = mock.clock(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(fleet.opened ?? 0).toBeGreaterThan(0)
})

test('an agent turning to waiting raises a toast', async ($, on) => {
  const fleet = world(on, { sessions: SESSIONS.replace('"waiting"', '"working"') })
  await $.command.run(RUN)
  fleet.sessions = SESSIONS
  await $.command.run(RUN)
  expect(fleet.toasts).toEqual(['lead: auth is waiting'])
})
