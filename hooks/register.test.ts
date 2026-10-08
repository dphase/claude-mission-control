import { expect, test } from 'claude-code/testing'
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
