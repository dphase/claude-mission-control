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
