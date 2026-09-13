import { shellPanelIndex } from './focused-panel';

/**
 * What the "close current shell" shortcut (Cmd/Ctrl+W) acts on.
 *
 * Standalone terminals occupy a top-level slot of their own, so the active id
 * IS the terminal; tasks instead address their shells by focused panel index.
 */
export type ShellCloseTarget =
  | { kind: 'terminal'; terminalId: string }
  | { kind: 'shell'; taskId: string; shellId: string };

interface ShellCloseState {
  activeTaskId: string | null;
  sidebarFocused: boolean;
  placeholderFocused: boolean;
  newTaskPanelFocused: boolean;
  terminals: Record<string, unknown>;
  tasks: Record<string, { shellAgentIds: string[] }>;
  focusedPanel: Record<string, string>;
}

export function resolveShellCloseTarget(state: ShellCloseState): ShellCloseTarget | null {
  // Focus can sit outside the active slot while `activeTaskId` still points at
  // it — the same reason `isPanelFocused` consults these flags. Killing a
  // live pty from a shortcut aimed outside that slot would be unrecoverable.
  if (state.sidebarFocused || state.placeholderFocused || state.newTaskPanelFocused) return null;

  const id = state.activeTaskId;
  if (!id) return null;

  if (state.terminals[id]) return { kind: 'terminal', terminalId: id };

  const index = shellPanelIndex(state.focusedPanel[id] ?? '');
  if (index === null) return null;

  const shellId = state.tasks[id]?.shellAgentIds[index];
  return shellId ? { kind: 'shell', taskId: id, shellId } : null;
}
