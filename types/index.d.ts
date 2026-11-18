export type FleetSession = {
  id: string
  name: string
  tool: string
  group: string
  status: string
  isSelf: boolean
}

export type Line = { text: string; tone: 'ok' | 'warn' | 'bad' | 'dim' | 'plain' }

export type OrchView = {
  isActive: boolean
  checkedAt: number
  root: string
  self?: FleetSession
  sessions: FleetSession[]
  archivedCount: number
  sessionsError?: string
  tasks: Line[]
  tasksError?: string
  reservations: Line[]
  reservationsError?: string
  hasStateDir: boolean
  plans: string[]
  ledgerTail?: string
  decisionsTail?: string
}

declare module 'claude-code' {
  interface PluginState {
    'orchestrator': { view: Shaped<OrchView> }
  }
}
