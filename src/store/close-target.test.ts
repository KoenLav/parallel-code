import { describe, it, expect } from 'vitest';
import { resolveShellCloseTarget } from './close-target';

const EMPTY = {
  activeTaskId: null,
  sidebarFocused: false,
  placeholderFocused: false,
  newTaskPanelFocused: false,
  terminals: {},
  tasks: {},
  focusedPanel: {},
};

const ACTIVE_TERMINAL = {
  ...EMPTY,
  activeTaskId: 'term-1',
  terminals: { 'term-1': { id: 'term-1' } },
  focusedPanel: { 'term-1': 'terminal' },
};

describe('resolveShellCloseTarget', () => {
  it('targets a standalone terminal when it is active', () => {
    expect(resolveShellCloseTarget(ACTIVE_TERMINAL)).toEqual({
      kind: 'terminal',
      terminalId: 'term-1',
    });
  });

  it('spares the active terminal while the sidebar has focus', () => {
    expect(resolveShellCloseTarget({ ...ACTIVE_TERMINAL, sidebarFocused: true })).toBeNull();
  });

  it('spares the active terminal while the placeholder has focus', () => {
    expect(resolveShellCloseTarget({ ...ACTIVE_TERMINAL, placeholderFocused: true })).toBeNull();
  });

  it('spares the active terminal while the new-task panel has focus', () => {
    expect(resolveShellCloseTarget({ ...ACTIVE_TERMINAL, newTaskPanelFocused: true })).toBeNull();
  });

  it('spares a focused task shell while the sidebar has focus', () => {
    expect(
      resolveShellCloseTarget({
        ...EMPTY,
        activeTaskId: 'task-1',
        sidebarFocused: true,
        tasks: { 'task-1': { shellAgentIds: ['shell-a'] } },
        focusedPanel: { 'task-1': 'shell:0' },
      }),
    ).toBeNull();
  });

  it('targets a standalone terminal with no recorded panel', () => {
    expect(resolveShellCloseTarget({ ...ACTIVE_TERMINAL, focusedPanel: {} })).toEqual({
      kind: 'terminal',
      terminalId: 'term-1',
    });
  });

  it('targets the focused shell of a task', () => {
    expect(
      resolveShellCloseTarget({
        ...EMPTY,
        activeTaskId: 'task-1',
        tasks: { 'task-1': { shellAgentIds: ['shell-a', 'shell-b'] } },
        focusedPanel: { 'task-1': 'shell:1' },
      }),
    ).toEqual({ kind: 'shell', taskId: 'task-1', shellId: 'shell-b' });
  });

  it('returns null when the focused task panel is not a shell', () => {
    expect(
      resolveShellCloseTarget({
        ...EMPTY,
        activeTaskId: 'task-1',
        tasks: { 'task-1': { shellAgentIds: ['shell-a'] } },
        focusedPanel: { 'task-1': 'ai-terminal:agent-a' },
      }),
    ).toBeNull();
  });

  it('returns null when the focused shell index has no agent', () => {
    expect(
      resolveShellCloseTarget({
        ...EMPTY,
        activeTaskId: 'task-1',
        tasks: { 'task-1': { shellAgentIds: [] } },
        focusedPanel: { 'task-1': 'shell:0' },
      }),
    ).toBeNull();
  });

  it('returns null when nothing is active', () => {
    expect(resolveShellCloseTarget(EMPTY)).toBeNull();
  });
});
