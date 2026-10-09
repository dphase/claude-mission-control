export type Meta = {
  title: string
  cwd: string
  model: string
  version: string
  startedAt: number
}

export type Git = {
  isRepo: boolean
  branch?: string
  upstream?: string
  ahead: number
  behind: number
  staged: number
  modified: number
  untracked: number
  conflicts: number
  added: number
  removed: number
  files: number
  stashes: number
  lastCommit?: { sha: string; subject: string; at: number }
  changes: FileChange[]
}

export type FileChange = { path: string; added: number; removed: number; isNew: boolean; isBinary: boolean }

export type FileEdit = { path: string; count: number; at: number }

export type PublishedArtifact = { url: string; title: string; at: number }

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Usage = {
  tokens?: number
  window: number
  percent?: number
  costUsd?: number
  limits: Limit[]
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type Task = {
  id: string
  subject: string
  activeForm?: string
  status: TaskStatus
  blockedBy: string[]
}

export type AgentRun = {
  toolUseId: string
  agentId?: string
  description: string
  type: string
  isBackground: boolean
  startedAt: number
  endedAt?: number
  steps: number
  lastTool?: string
  status: 'running' | 'done' | 'failed'
  expectedMs?: number
}

export type Recap = {
  ask: string
  workingOn: string
  done: string[]
  next: string
  at: number
  isThinking: boolean
}

export type Live = {
  isBusy: boolean
  turnStartedAt?: number
  frame: number
  now: number
}

declare module 'claude-code' {
  interface PluginState {
    'mission-control': {
      meta: Meta
      usage: Usage
      tasks: Task[]
      agents: AgentRun[]
      recap: Recap
      live: Live
      folded: Record<string, boolean>
      history: number[]
      git: Git
      edits: FileEdit[]
      artifacts: PublishedArtifact[]
    }
  }
}
