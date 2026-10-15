import { expect, mock, test } from 'claude-code/testing'
import type { RenderPropsOf } from 'claude-code'

const PANE = {
  plugin: 'mission-control',
  component: 'Pane',
  requestId: 'mission-control',
  props: { title: 'Mission Control', isFocused: false, bodyColumns: 44, placement: 'dock' } as unknown as RenderPropsOf['Pane'],
} as const

const TODOS = [
  { content: 'Write the schema', status: 'completed', activeForm: 'Writing the schema' },
  { content: 'Run the tests', status: 'in_progress', activeForm: 'Running the tests' },
  { content: 'Update the docs', status: 'pending', activeForm: 'Updating the docs' },
] as const

test('the recap is always drawn, even before the first prompt', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /Waiting for the first prompt/ })).toBeDefined()
    expect(await ui.find({ key: 'h-recap' })).toBeDefined()
    await ui.unmount()
  }
})

test('a TodoWrite fills the task list and its progress', async ($, on) => {
  on('tool.call', { tool: 'TodoWrite' }, () => ({
    result: { oldTodos: [], newTodos: [...TODOS] },
  }))
  await $.tool.call({ tool: 'TodoWrite', todos: [...TODOS] })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'h-tasks', text: /Todo/ })).toBeDefined()
    expect(await ui.find({ text: '1 / 3' })).toBeDefined()
    expect(await ui.find({ text: '[✓]' })).toBeDefined()
    expect(await ui.find({ text: /Running the tests/ })).toBeDefined()
    expect(await ui.find({ text: /Update the docs/ })).toBeDefined()

    await ui.press({ key: 'h-tasks' })
    expect(await ui.find({ text: /Update the docs/ })).toBeUndefined()
    await ui.press({ key: 'h-tasks' })
    await ui.unmount()
  }
})

test('a published artifact is listed and opens in the browser when pressed', async ($, on) => {
  const URL = 'https://claude.ai/code/artifact/1234abcd-0000-4000-8000-000000000000'
  on('tool.call', { tool: 'Artifact' }, () => ({ result: { url: URL } }) as never)
  mock.clock(on)
  const opened: string[][] = []
  on('process.run', ($, e) => {
    opened.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.tool.call({ tool: 'Artifact', file_path: 'report.html', title: 'Weekly Report' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'h-artifacts', text: /Artifacts/ })).toBeDefined()
  expect(await ui.find({ text: /Weekly Report/ })).toBeDefined()
  await ui.press({ key: `a-${URL}` })
  expect(opened.some(argv => argv.includes(URL))).toBe(true)
  await ui.unmount()
})

test("reading an earlier session's artifact lists it under its page title", async ($, on) => {
  const URL = 'https://claude.ai/artifact/RHFYAq5GtnrmvugwVdeidU'
  on('tool.call', { tool: 'Artifact' }, () => ({ result: '[Artifact c4a0]\n<html><title>Concierge Build Plan</title></html>' }) as never)
  mock.clock(on)
  await $.tool.call({ tool: 'Artifact', action: 'read', url: URL } as never)
  await $.tool.call({ tool: 'Artifact', action: 'read', url: URL, path: 'data.json' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /Concierge Build Plan/ })).toBeDefined()
  expect(await ui.find({ key: 'h-artifacts', text: /Artifacts/ })).toBeDefined()
  await ui.unmount()
})

test('a listing names a read artifact whose page had no title', async ($, on) => {
  const URL = 'https://claude.ai/artifact/YPLumdAyYM4y1AqciQ6j3m'
  on('tool.call', { tool: 'Artifact' }, ($, e) =>
    (e as { action?: string }).action === 'list'
      ? ({ result: `2 published artifacts:\n- (mine) Concierge: features and manual tests — ${URL} — updated 2026-10-09` } as never)
      : ({ result: '[Artifact fe29] created from an Artifact type; the page is left out' } as never),
  )
  mock.clock(on)
  await $.tool.call({ tool: 'Artifact', action: 'read', url: URL } as never)
  await $.tool.call({ tool: 'Artifact', action: 'list' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /Concierge: features and manual tests/ })).toBeDefined()
  await ui.unmount()
})

test('/mc refills the Artifacts list from the transcript after a resume', async ($, on) => {
  const URL = 'https://claude.ai/artifact/Nz2EpRnUDYovsDy4KLxcjm'
  const found = [
    { url: URL, title: 'Translation Review', filePath: '', at: 1 },
    { url: URL, title: '', filePath: '', at: 2 },
  ]
  on('process.run', ($, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv[0] === 'python3' ? JSON.stringify(found) : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('session.id', () => ({ value: 'a6f5d499-26e8-4709-b42b-5f29131e5816' }) as never)
  on('ui.panes', () => ({ value: [] }) as never)
  on('session.messages', () => ({ value: [] }) as never)
  await $.command.run({ command: 'mc', args: 'recap' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'h-artifacts', text: /Artifacts/ })).toBeDefined()
  expect(await ui.find({ text: /Translation Review/ })).toBeDefined()
  await ui.unmount()
})
