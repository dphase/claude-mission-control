import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, FileEdit, Git, Live, Meta, Recap, Task, Usage } from '../types'

const PANE = 'mission-control'
const TITLE = 'Mission Control'
const PANE_COLUMNS = 45

const metaAtom = atom({ plugin: 'mission-control', key: 'meta' } as const, {
  title: '',
  cwd: '',
  model: '',
  version: '',
  startedAt: 0,
} as Meta)
const usageAtom = atom({ plugin: 'mission-control', key: 'usage' } as const, { window: 0, limits: [] } as Usage)
const tasksAtom = atom({ plugin: 'mission-control', key: 'tasks' } as const, [] as Task[])
const agentsAtom = atom({ plugin: 'mission-control', key: 'agents' } as const, [] as AgentRun[])
const recapAtom = atom({ plugin: 'mission-control', key: 'recap' } as const, {
  ask: '',
  workingOn: '',
  done: [],
  next: '',
  at: 0,
  isThinking: false,
} as Recap)
const liveAtom = atom({ plugin: 'mission-control', key: 'live' } as const, { isBusy: false, frame: 0, now: 0 } as Live)
const foldedAtom = atom({ plugin: 'mission-control', key: 'folded' } as const, {} as Record<string, boolean>)
const historyAtom = atom({ plugin: 'mission-control', key: 'history' } as const, [] as number[])
const gitAtom = atom({ plugin: 'mission-control', key: 'git' } as const, {
  isRepo: false,
  ahead: 0,
  behind: 0,
  staged: 0,
  modified: 0,
  untracked: 0,
  conflicts: 0,
  added: 0,
  removed: 0,
  files: 0,
  stashes: 0,
  changes: [],
} as Git)
const editsAtom = atom({ plugin: 'mission-control', key: 'edits' } as const, [] as FileEdit[])

// Tokyo Night on a near-black ground: sky blue for structure, purple for the meters.
const C = {
  bg: '#101319',
  purple: '#bb9af7',
  sky: '#76c4f1',
  skyLight: '#a6daf8',
  skyMid: '#5aa9d9',
  skyDeep: '#3f7fa8',
  violet: '#9d7cd8',
  track: '#262a3d',
  fg: '#c0caf5',
  soft: '#a9b1d6',
  muted: '#6b7394',
  faint: '#454b66',
  green: '#9ece6a',
  red: '#f7768e',
  yellow: '#e0af68',
  orange: '#ff9e64',
  cyan: '#7dcfff',
  blue: '#7aa2f7',
}

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
const CELL = '■'
const TICK_MS = 250
const RECAP_MESSAGES = 16
const MAX_FILES = 30

const RECAP_SYSTEM = `You maintain a terse status sidebar for a coding session between a developer and an AI coding agent.
Read the recent transcript and task list, then answer with ONLY a JSON object, no prose, no code fence:
{"workingOn": "<one sentence, what the agent is doing right now or just finished>",
 "done": ["<up to 4 short past-tense items actually completed this session, newest last>"],
 "next": "<one sentence: the next concrete step, or what the agent is waiting on from the developer>"}
Each string under 80 characters. Plain words, no markdown, no emoji. Name files, commands and tickets when they matter.`

// ---------- formatting ----------

const n = (value: number) => Math.round(value).toLocaleString('en-US')

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat
}

const duration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

const ago = (ms: number) => {
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

// Purple while there is room, warming only as it runs out.
const heat = (percent: number) => (percent < 70 ? C.purple : percent < 85 ? C.yellow : percent < 95 ? C.orange : C.red)

const cells = (fraction: number, width: number) => {
  const total = Math.max(1, width)
  const on = Math.round(Math.min(1, Math.max(0, fraction)) * total)
  return { on: CELL.repeat(on), off: CELL.repeat(total - on) }
}

const sparkline = (values: number[], width: number) =>
  values
    .slice(-width)
    .map(v => SPARK[Math.min(SPARK.length - 1, Math.floor((v / 100) * SPARK.length))])
    .join('')

const tildify = (path: string) => path.replace(/^\/(Users|home)\/[^/]+/, '~')

const basename = (path: string) => path.split('/').filter(Boolean).pop() ?? path


// ---------- data ----------

async function refreshUsage($: EngineInterface) {
  const usage = await $.session.usage()
  const next: Usage = {
    tokens: usage.context.tokens,
    window: usage.context.window,
    percent: usage.context.percent,
    costUsd: usage.cost?.usd,
    limits: usage.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
  }
  const prev = await read($, usageAtom)
  if (JSON.stringify(prev) !== JSON.stringify(next)) await update($, usageAtom, () => next)
}

async function refreshMeta($: EngineInterface) {
  const [cwd, model, version, usage] = await Promise.all([
    $.session.cwd(),
    $.session.model(),
    $.session.version(),
    $.session.usage(),
  ])
  const repo = await $.session.repo().catch(() => null)
  const fallback = repo?.name ?? basename(cwd) ?? 'session'
  await update($, metaAtom, meta => ({
    title: meta.title || fallback,
    cwd,
    model,
    version: version.version,
    startedAt: usage.startedAt,
  }))
}

let isGitRunning = false
let isGitQueued = false

async function refreshGit($: EngineInterface) {
  if (isGitRunning) {
    isGitQueued = true
    return
  }
  isGitRunning = true
  try {
    const cwd = await $.session.cwd()
    const git = (args: string[]) =>
      $.process.run(['git', '--no-optional-locks', ...args], { cwd, timeoutMs: 4000 }).catch(() => undefined)

    const status = await git(['status', '--porcelain=v2', '--branch'])
    if (!status || status.exitCode !== 0) {
      await update($, gitAtom, g => (g.isRepo ? { ...g, isRepo: false } : g))
      return
    }
    const next: Git = {
      isRepo: true,
      ahead: 0,
      behind: 0,
      staged: 0,
      modified: 0,
      untracked: 0,
      conflicts: 0,
      added: 0,
      removed: 0,
      files: 0,
      stashes: 0,
      changes: [],
    }
    for (const line of status.stdout.split('\n')) {
      if (line.startsWith('# branch.head ')) next.branch = line.slice(14).trim()
      else if (line.startsWith('# branch.upstream ')) next.upstream = line.slice(18).trim()
      else if (line.startsWith('# branch.ab ')) {
        const [a, b] = line.slice(12).trim().split(' ')
        next.ahead = Math.abs(Number(a) || 0)
        next.behind = Math.abs(Number(b) || 0)
      } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
        const xy = line.slice(2, 4)
        if (xy[0] !== '.') next.staged += 1
        if (xy[1] !== '.') next.modified += 1
      } else if (line.startsWith('u ')) next.conflicts += 1
      else if (line.startsWith('? ')) next.untracked += 1
    }

    const [numstat, untracked, log, stash] = await Promise.all([
      git(['diff', '--numstat', 'HEAD']),
      git(['ls-files', '--others', '--exclude-standard']),
      git(['log', '-1', '--format=%h%x1f%s%x1f%ct']),
      git(['stash', 'list', '--format=%gd']),
    ])
    for (const line of (numstat?.stdout ?? '').split('\n')) {
      const [a, r, ...rest] = line.split('\t')
      const path = rest.join('\t')
      if (!path) continue
      const isBinary = a === '-'
      next.changes.push({ path, added: Number(a) || 0, removed: Number(r) || 0, isNew: false, isBinary })
    }
    for (const path of (untracked?.stdout ?? '').split('\n').filter(Boolean).slice(0, 200)) {
      next.changes.push({ path, added: 0, removed: 0, isNew: true, isBinary: false })
    }
    next.files = next.changes.length
    next.added = next.changes.reduce((sum, c) => sum + c.added, 0)
    next.removed = next.changes.reduce((sum, c) => sum + c.removed, 0)
    const [sha, subject, ct] = (log?.stdout.trim() ?? '').split('\x1f')
    if (sha && subject) next.lastCommit = { sha, subject, at: Number(ct) * 1000 }
    next.stashes = (stash?.stdout ?? '').split('\n').filter(Boolean).length

    const prev = await read($, gitAtom)
    if (JSON.stringify(prev) !== JSON.stringify(next)) await update($, gitAtom, () => next)
  } finally {
    isGitRunning = false
    if (isGitQueued) {
      isGitQueued = false
      void refreshGit($)
    }
  }
}

async function expectedMsFor($: EngineInterface, type: string) {
  const past = (await $.store.get(`durations:${type}`)) as number[] | undefined
  if (!past || past.length === 0) return undefined
  const sorted = [...past].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function rememberDuration($: EngineInterface, type: string, ms: number) {
  const past = ((await $.store.get(`durations:${type}`)) as number[] | undefined) ?? []
  await $.store.set(`durations:${type}`, [...past, ms].slice(-20))
}

let isRecapRunning = false
let isRecapQueued = false

async function refreshRecap($: EngineInterface) {
  if (isRecapRunning) {
    isRecapQueued = true
    return
  }
  isRecapRunning = true
  try {
    const messages = (await $.session.messages()).slice(-RECAP_MESSAGES)
    if (messages.length === 0) return
    await update($, recapAtom, r => ({ ...r, isThinking: true }))
    const tasks = await read($, tasksAtom)
    const transcript = messages
      .map(m => {
        const tools = m.toolUses.length ? ` [tools: ${m.toolUses.map(t => t.tool).slice(0, 10).join(', ')}]` : ''
        return `${m.role.toUpperCase()}: ${clip(m.text, 900)}${tools}`
      })
      .join('\n\n')
    const taskLines = tasks.map(t => `- [${t.status}] ${t.subject}`).join('\n') || '(none)'
    const reply = await $.model.complete({
      model: 'haiku',
      system: RECAP_SYSTEM,
      prompt: `TASKS:\n${taskLines}\n\nRECENT TRANSCRIPT:\n${transcript}`,
      maxTokens: 400,
      timeoutMs: 30_000,
    })
    const at = await $.clock.now()
    if (!reply.isAnswered) {
      await update($, recapAtom, r => ({ ...r, isThinking: false }))
      return
    }
    const match = reply.text.match(/\{[\s\S]*\}/)
    const parsed = match ? (JSON.parse(match[0]) as Partial<Recap>) : {}
    await update($, recapAtom, r => ({
      ...r,
      workingOn: typeof parsed.workingOn === 'string' ? parsed.workingOn : r.workingOn,
      done: Array.isArray(parsed.done) ? parsed.done.filter(d => typeof d === 'string').slice(-4) : r.done,
      next: typeof parsed.next === 'string' ? parsed.next : r.next,
      at,
      isThinking: false,
    }))
  } catch {
    await update($, recapAtom, r => ({ ...r, isThinking: false }))
  } finally {
    isRecapRunning = false
    if (isRecapQueued) {
      isRecapQueued = false
      void refreshRecap($)
    }
  }
}

let ticks = 0

async function tick($: EngineInterface) {
  ticks += 1
  const [live, agents] = await Promise.all([read($, liveAtom), read($, agentsAtom)])
  const isAnimating = live.isBusy || agents.some(a => a.status === 'running')
  if (isAnimating || ticks % 20 === 0) {
    const now = await $.clock.now()
    await update($, liveAtom, l => ({ ...l, frame: l.frame + 1, now }))
  }
  if (ticks % 12 === 0) await refreshUsage($)
  if (ticks % 40 === 0) await refreshGit($)
  if (ticks % 240 === 0) await refreshMeta($)
}

async function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mc',
      description: 'Mission Control sidebar: /mc toggles it, /mc recap refreshes the recap',
      argumentHint: '[recap|open|close]',
    })
    await refreshMeta($)
    await refreshUsage($)
    void refreshGit($)
    $.clock.every(TICK_MS, () => void tick($))
    if ((await $.store.get('isClosedByPerson')) !== true) void openPane($)

    return next(e)
  })

  on('command.run', { command: 'mc' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
    if (arg === 'recap') {
      void refreshRecap($)
      return { text: 'Mission Control: refreshing the recap.' }
    }
    if (arg === 'close' || (arg === '' && isOpen)) {
      await $.store.set('isClosedByPerson', true)
      await $.ui.close({ id: PANE })
      return { text: 'Mission Control closed. /mc brings it back.' }
    }
    await $.store.set('isClosedByPerson', false)
    const opened = await openPane($)
    return { text: opened.isPlaced ? 'Mission Control open.' : 'Mission Control is waiting for a wider terminal.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await $.store.set('isClosedByPerson', true)
    return next(e)
  }).catch(($, e, next) => next(e))

  // The session's own title, when it has one (/rename, a set-title hook, the app).
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const title = e.session_title?.trim()
    if (title) await update($, metaAtom, m => ({ ...m, title }))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.SessionStart', async ($, e, next) => {
    const title = e.session_title?.trim()
    if (title) await update($, metaAtom, m => ({ ...m, title }))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, liveAtom, l => ({ ...l, isBusy: true, turnStartedAt: now, now }))
    const ask = clip(e.text.split('\n').find(line => line.trim()) ?? '', 160)
    if (ask && !ask.startsWith('<')) await update($, recapAtom, r => ({ ...r, ask, workingOn: r.workingOn || ask }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.agentId !== undefined) {
      const agents = await read($, agentsAtom)
      const run = agents.find(a => a.agentId === e.agentId)
      if (run && run.status === 'running') {
        const isFailed = e.isAborted || e.reason === 'error' || e.reason === 'refusal'
        await update($, agentsAtom, list =>
          list.map(a =>
            a.agentId === e.agentId ? { ...a, status: isFailed ? 'failed' : 'done', endedAt: now } : a,
          ),
        )
        if (!isFailed) await rememberDuration($, run.type, now - run.startedAt)
      }
      return next(e)
    }

    await update($, liveAtom, l => ({ ...l, isBusy: false, now }))
    await refreshUsage($)
    const { percent } = await read($, usageAtom)
    if (percent !== undefined) await update($, historyAtom, h => [...h, percent].slice(-64))
    $.clock.after(0, () => {
      void refreshRecap($)
      void refreshGit($)
    })
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const now = await $.clock.now()
    const type = e.subagentType || 'general-purpose'
    const expectedMs = await expectedMsFor($, type)
    const run: AgentRun = {
      toolUseId: e.tool_use_id,
      description: e.description || e.name || type,
      type,
      isBackground: e.background,
      startedAt: now,
      steps: 0,
      status: 'running',
      expectedMs,
    }
    await update($, agentsAtom, list => [...list.filter(a => a.toolUseId !== run.toolUseId), run].slice(-30))
    const spawned = await next(e)
    await update($, agentsAtom, list =>
      list.map(a =>
        a.toolUseId !== run.toolUseId
          ? a
          : spawned.deny !== undefined
            ? { ...a, status: 'failed', endedAt: now }
            : { ...a, agentId: spawned.agentId },
      ),
    )
    return spawned
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const tool = String(e.tool).replace(/^mcp__[^_]+__/, '')
      await update($, agentsAtom, list =>
        list.map(a => (a.agentId === e.agentId ? { ...a, steps: a.steps + 1, lastTool: tool } : a)),
      )
    }

    if (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') {
      const path = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
      const ran = await next(e)
      if (ran.deny === undefined && !ran.isError) {
        const at = await $.clock.now()
        await update($, editsAtom, list => {
          const prior = list.find(f => f.path === path)
          const rest = list.filter(f => f.path !== path)
          return [...rest, { path, count: (prior?.count ?? 0) + 1, at }].slice(-50)
        })
        void refreshGit($)
      }
      return ran
    }

    if (e.tool === 'Bash') {
      const ran = await next(e)
      void refreshGit($)
      return ran
    }

    if (e.tool === 'TodoWrite') {
      const todos = e.todos
      const ran = await next(e)
      if (ran.deny === undefined && !ran.isError) {
        await update($, tasksAtom, () =>
          todos.map((t, i) => ({
            id: `todo-${i}`,
            subject: t.content,
            activeForm: t.activeForm,
            status: t.status,
            blockedBy: [],
          })),
        )
      }
      return ran
    }

    if (e.tool === 'TaskCreate') {
      const { subject, activeForm } = e
      const ran = await next(e)
      const id = (ran.result as { task?: { id?: string } } | undefined)?.task?.id
      if (id) {
        await update($, tasksAtom, list => [
          ...list.filter(t => t.id !== id && !t.id.startsWith('todo-')),
          { id, subject, activeForm, status: 'pending' as const, blockedBy: [] },
        ])
      }
      return ran
    }

    if (e.tool === 'TaskUpdate') {
      const patch = e
      const status = patch.status
      const ran = await next(e)
      if (ran.deny === undefined && !ran.isError) {
        await update($, tasksAtom, list =>
          status === 'deleted'
            ? list.filter(t => t.id !== patch.taskId)
            : list.map(t =>
                t.id !== patch.taskId
                  ? t
                  : {
                      ...t,
                      subject: patch.subject ?? t.subject,
                      activeForm: patch.activeForm ?? t.activeForm,
                      status: status ?? t.status,
                      blockedBy: [...new Set([...t.blockedBy, ...(patch.addBlockedBy ?? [])])],
                    },
              ),
        )
      }
      return ran
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // ---------- drawing ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [meta, usage, tasks, agents, recap, live, folded, history, git, edits] = await Promise.all([
      read($, metaAtom),
      read($, usageAtom),
      read($, tasksAtom),
      read($, agentsAtom),
      read($, recapAtom),
      read($, liveAtom),
      read($, foldedAtom),
      read($, historyAtom),
      read($, gitAtom),
      read($, editsAtom),
    ])
    const W = Math.max(24, e.props.bodyColumns - 4)
    const bodyRows = e.props.scroll?.bodyRows
    const spin = SPIN[live.frame % SPIN.length]
    const now = live.now || meta.startedAt

    const toggle = (section: string) => () => update($, foldedAtom, f => ({ ...f, [section]: !f[section] }))

    // A section's head: the fold control and its name on the left, a figure on the right.
    const Head = (props: { id: string; label: string; right?: string; rightColor?: string }) => (
      <Box flexDirection="row" justifyContent="space-between" marginBottom={folded[props.id] ? 0 : 1}>
        <Button key={`h-${props.id}`} plain onPress={toggle(props.id)}>
          <Text color={C.skyDeep}>{folded[props.id] ? '▸' : '▾'}</Text>
          <Text>{'  '}</Text>
          <Text bold color={C.sky}>
            {props.label}
          </Text>
        </Button>
        <Text color={props.rightColor ?? C.muted}>{props.right ?? ''}</Text>
      </Box>
    )

    const Bar = (props: { fraction: number; width: number; color: string }) => {
      const c = cells(props.fraction, props.width)
      return (
        <Text wrap="truncate-end">
          <Text color={props.color}>{c.on}</Text>
          <Text color={C.track}>{c.off}</Text>
        </Text>
      )
    }

    const Row = (props: { left: string; right?: string; leftColor?: string; rightColor?: string }) => (
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={props.leftColor ?? C.soft} wrap="truncate-end">
          {props.left}
        </Text>
        <Text color={props.rightColor ?? C.muted}>{props.right ?? ''}</Text>
      </Box>
    )

    const section = (id: string, body: ReturnType<typeof Row>) => (
      <Box flexDirection="column" marginBottom={1} key={`s-${id}`}>
        {body}
      </Box>
    )

    // --- title ---
    const title = (
      <Box flexDirection="column" marginBottom={1} key="title">
        <Text bold color={C.skyLight} wrap="truncate-end">
          {live.isBusy ? spin : '◆'}
          {'  '}
          {meta.title || 'session'}
        </Text>
        <Text color={C.muted} wrap="truncate-end">
          {'   '}
          {meta.model}
          {live.isBusy && live.turnStartedAt ? `    working ${duration(now - live.turnStartedAt)}` : '    idle'}
        </Text>
      </Box>
    )

    // --- context + quota ---
    const pct = usage.percent ?? (usage.tokens && usage.window ? (usage.tokens / usage.window) * 100 : 0)
    const context = section(
      'context',
      <Box flexDirection="column">
        <Head id="context" label="Context" right={`${Math.round(pct)}%`} rightColor={heat(pct)} />
        {folded.context ? null : (
          <Box flexDirection="column">
            <Bar fraction={pct / 100} width={W} color={heat(pct)} />
            <Row
              left={`${usage.tokens !== undefined ? n(usage.tokens) : '—'}  of  ${usage.window ? n(usage.window) : '—'}`}
              right={usage.costUsd !== undefined ? `$${usage.costUsd.toFixed(2)}` : ''}
              rightColor={C.green}
            />
            {history.length > 1 ? (
              <Row left={sparkline(history, W - 12)} leftColor={C.skyDeep} right="per turn" />
            ) : null}
          </Box>
        )}
      </Box>,
    )

    // --- git ---
    const churn = git.added + git.removed
    const sessionEdits = [...edits].sort((a, b) => b.at - a.at)
    const gitBlock = !git.isRepo
      ? null
      : section(
          'git',
          <Box flexDirection="column">
            <Head id="git" label="Git" right={git.branch ? `⎇  ${clip(git.branch, W - 12)}` : 'detached'} rightColor={C.cyan} />
            {folded.git ? null : (
              <Box flexDirection="column">
                <Box flexDirection="row" gap={3}>
                  <Text color={git.ahead ? C.green : C.faint}>↑ {git.ahead}</Text>
                  <Text color={git.behind ? C.yellow : C.faint}>↓ {git.behind}</Text>
                  <Text color={C.faint} wrap="truncate-end">
                    {git.upstream ?? 'no upstream'}
                  </Text>
                </Box>
                <Box flexDirection="row" gap={3}>
                  <Text color={git.staged ? C.green : C.faint}>● {git.staged} staged</Text>
                  <Text color={git.modified ? C.yellow : C.faint}>✚ {git.modified} changed</Text>
                  <Text color={git.untracked ? C.blue : C.faint}>? {git.untracked} new</Text>
                </Box>
                {git.conflicts > 0 ? <Text color={C.red}>✖ {git.conflicts} conflicted</Text> : null}
                {churn > 0 ? (
                  <Box flexDirection="column" marginTop={1}>
                    <Text wrap="truncate-end">
                      <Text color={C.green}>{CELL.repeat(Math.round((git.added / churn) * W))}</Text>
                      <Text color={C.red}>{CELL.repeat(W - Math.round((git.added / churn) * W))}</Text>
                    </Text>
                    <Box flexDirection="row" justifyContent="space-between">
                      <Box flexDirection="row" gap={2}>
                        <Text color={C.green}>+{n(git.added)}</Text>
                        <Text color={C.red}>−{n(git.removed)}</Text>
                      </Box>
                      <Text color={C.muted}>
                        {git.files} {git.files === 1 ? 'file' : 'files'}
                      </Text>
                    </Box>
                  </Box>
                ) : null}
                {git.lastCommit ? (
                  <Box flexDirection="column" marginTop={1}>
                    <Text wrap="truncate-end">
                      <Text color={C.skyDeep}>{git.lastCommit.sha}</Text>
                      <Text>{'  '}</Text>
                      <Text color={C.soft}>{git.lastCommit.subject}</Text>
                    </Text>
                    <Row
                      left={`${' '.repeat(git.lastCommit.sha.length + 2)}${ago(now - git.lastCommit.at)}`}
                      leftColor={C.faint}
                      right={git.stashes ? `${git.stashes} stashed` : ''}
                    />
                  </Box>
                ) : null}
              </Box>
            )}
          </Box>,
        )

    // --- modified files: every change against HEAD, the ones this session touched marked ---
    const touched = (path: string) => sessionEdits.some(edit => edit.path === path || edit.path.endsWith(`/${path}`))
    const changes = [...git.changes].sort((a, b) => Number(touched(b.path)) - Number(touched(a.path)) || a.path.localeCompare(b.path))
    const shown = changes.slice(0, MAX_FILES)
    const filesBlock =
      changes.length === 0
        ? null
        : section(
            'files',
            <Box flexDirection="column">
              <Head id="files" label="Modified Files" right={`${changes.length}`} />
              {folded.files ? null : (
                <Box flexDirection="column">
                  {shown.map(change => (
                    <Box flexDirection="row" key={`f-${change.path}`}>
                      <Text color={touched(change.path) ? C.sky : C.faint}>{touched(change.path) ? '● ' : '  '}</Text>
                      <Box flexGrow={1} flexShrink={1} overflow="hidden">
                        <Text color={touched(change.path) ? C.fg : C.soft} wrap="truncate-middle">
                          {change.path}
                        </Text>
                      </Box>
                      <Box flexShrink={0} marginLeft={1} gap={1}>
                        {change.isNew ? <Text color={C.blue}>new</Text> : null}
                        {change.isBinary ? <Text color={C.muted}>bin</Text> : null}
                        {change.added > 0 ? <Text color={C.green}>+{change.added}</Text> : null}
                        {change.removed > 0 ? <Text color={C.red}>−{change.removed}</Text> : null}
                      </Box>
                    </Box>
                  ))}
                  {changes.length > shown.length ? (
                    <Text color={C.faint}>{`  … ${changes.length - shown.length} more`}</Text>
                  ) : null}
                </Box>
              )}
            </Box>,
          )

    // --- tasks ---
    const doneCount = tasks.filter(t => t.status === 'completed').length
    const openIds = new Set(tasks.filter(t => t.status !== 'completed').map(t => t.id))
    const tasksBlock =
      tasks.length === 0
        ? null
        : section(
            'tasks',
            <Box flexDirection="column">
              <Head id="tasks" label="Todo" right={`${doneCount} / ${tasks.length}`} />
              {folded.tasks ? null : (
                <Box flexDirection="column">
                  <Bar fraction={doneCount / tasks.length} width={W} color={C.purple} />
                  <Box flexDirection="column" marginTop={1}>
                    {tasks.map(task => {
                      const isBlocked = task.status === 'pending' && task.blockedBy.some(id => openIds.has(id))
                      const isDone = task.status === 'completed'
                      const isActive = task.status === 'in_progress'
                      const mark = isDone ? '[✓]' : isActive ? `[${spin}]` : isBlocked ? '[⊘]' : '[ ]'
                      const markColor = isDone ? C.green : isActive ? C.yellow : isBlocked ? C.red : C.faint
                      const textColor = isDone ? C.muted : isActive ? C.yellow : isBlocked ? C.muted : C.soft
                      return (
                        <Box flexDirection="row">
                          <Box flexShrink={0} width={4}>
                            <Text color={markColor}>{mark}</Text>
                          </Box>
                          <Box flexGrow={1} flexShrink={1}>
                            <Text color={textColor} bold={isActive} wrap="wrap">
                              {isActive ? task.activeForm || task.subject : task.subject}
                            </Text>
                          </Box>
                        </Box>
                      )
                    })}
                  </Box>
                </Box>
              )}
            </Box>,
          )

    // --- agents ---
    const running = agents.filter(a => a.status === 'running')
    const finished = agents.filter(a => a.status !== 'running').slice(-3)
    const agentsBlock =
      agents.length === 0
        ? null
        : section(
            'agents',
            <Box flexDirection="column">
              <Head
                id="agents"
                label="Agents"
                right={running.length ? `${running.length} running` : `${finished.length} done`}
                rightColor={running.length ? C.sky : C.muted}
              />
              {folded.agents ? null : (
                <Box flexDirection="column">
                  {running.map(agent => {
                    const elapsed = now - agent.startedAt
                    const expected = agent.expectedMs
                    const eta = expected ? expected - elapsed : undefined
                    const isOver = eta !== undefined && eta < 0
                    const sweep = (live.frame % (W + 6)) - 6
                    return (
                      <Box flexDirection="column" marginBottom={1} key={`agent-${agent.toolUseId}`}>
                        <Text color={C.fg} wrap="truncate-end">
                          <Text color={C.sky}>{spin}</Text>
                          {'  '}
                          {agent.description}
                        </Text>
                        <Row
                          left={`   ${agent.type}${agent.isBackground ? '  bg' : ''}   ${agent.steps} steps${agent.lastTool ? `   ${agent.lastTool}` : ''}`}
                          leftColor={C.muted}
                          right={
                            eta === undefined
                              ? duration(elapsed)
                              : isOver
                                ? `${duration(elapsed)}  +${duration(-eta)}`
                                : `${duration(elapsed)}  ~${duration(eta)}`
                          }
                          rightColor={isOver ? C.orange : C.soft}
                        />
                        {expected ? (
                          <Bar fraction={Math.min(0.97, elapsed / expected)} width={W} color={isOver ? C.orange : C.purple} />
                        ) : (
                          // No history for this agent type yet: a sweep instead of a guess.
                          <Text wrap="truncate-end">
                            <Text color={C.track}>{CELL.repeat(Math.max(0, sweep))}</Text>
                            <Text color={C.purple}>{CELL.repeat(Math.max(0, Math.min(6, W - sweep, 6 + sweep)))}</Text>
                            <Text color={C.track}>{CELL.repeat(Math.max(0, W - Math.max(0, sweep) - Math.max(0, Math.min(6, W - sweep, 6 + sweep))))}</Text>
                          </Text>
                        )}
                      </Box>
                    )
                  })}
                  {finished.map(agent => (
                    <Row
                      left={`${agent.status === 'done' ? '✓' : '✗'}  ${agent.description}`}
                      leftColor={agent.status === 'done' ? C.muted : C.red}
                      right={agent.endedAt ? duration(agent.endedAt - agent.startedAt) : ''}
                      rightColor={C.faint}
                    />
                  ))}
                </Box>
              )}
            </Box>,
          )

    // --- recap: always shown ---
    const recapAge = recap.isThinking ? `${spin}  thinking` : recap.at ? ago(now - recap.at) : ''
    const recapBlock = section(
      'recap',
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" marginBottom={folded.recap ? 0 : 1}>
          <Button key="h-recap" plain onPress={toggle('recap')}>
            <Text color={C.skyDeep}>{folded.recap ? '▸' : '▾'}</Text>
            <Text>{'  '}</Text>
            <Text bold color={C.sky}>
              Recap
            </Text>
          </Button>
          <Box flexDirection="row" gap={2}>
            <Text color={recap.isThinking ? C.sky : C.muted}>{recapAge}</Text>
            <Button key="recap-refresh" plain onPress={() => void refreshRecap($)}>
              <Text color={C.skyDeep}>↻</Text>
            </Button>
          </Box>
        </Box>
        {folded.recap ? null : (
          <Box flexDirection="column">
            <Text color={C.skyMid}>Working on</Text>
            <Box paddingLeft={3}>
              <Text color={C.fg} wrap="wrap">
                {recap.workingOn || recap.ask || 'Waiting for the first prompt.'}
              </Text>
            </Box>
            {recap.done.length > 0 ? (
              <Box flexDirection="column" marginTop={1}>
                <Text color={C.skyMid}>Done</Text>
                {recap.done.map(item => (
                  <Box flexDirection="row">
                    <Text color={C.green}>{' ✓ '}</Text>
                    <Text color={C.soft} wrap="wrap">
                      {item}
                    </Text>
                  </Box>
                ))}
              </Box>
            ) : null}
            {recap.next ? (
              <Box flexDirection="column" marginTop={1}>
                <Text color={C.skyMid}>Next</Text>
                <Box flexDirection="row">
                  <Text color={C.yellow}>{' → '}</Text>
                  <Text color={C.fg} wrap="wrap">
                    {recap.next}
                  </Text>
                </Box>
              </Box>
            ) : null}
          </Box>
        )}
      </Box>,
    )

    // --- footer ---
    const footer = (
      <Box flexDirection="column" key="footer">
        <Box flexDirection="row" justifyContent="flex-end">
          <Text wrap="truncate-start">
            <Text color={C.muted}>{tildify(meta.cwd)}</Text>
            {git.branch ? <Text color={C.cyan}>:{git.branch}</Text> : ''}
          </Text>
        </Box>
        <Box flexDirection="row" justifyContent="flex-end">
          <Text color={C.muted}>{meta.version.split('-')[0]}</Text>
        </Box>
      </Box>
    )

    return (
      <Box
        flexDirection="column"
        backgroundColor={C.bg}
        paddingX={2}
        paddingTop={1}
        width={e.props.bodyColumns}
        minHeight={bodyRows}
      >
        {title}
        {context}
        {tasksBlock}
        {agentsBlock}
        {recapBlock}
        {gitBlock}
        {filesBlock}
        <Box flexGrow={1} />
        {footer}
      </Box>
    )
  })
}
