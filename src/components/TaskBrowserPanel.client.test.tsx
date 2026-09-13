import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { appendBrowserReference } from '../store/store';
import { TaskBrowserPanel } from './TaskBrowserPanel';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock('../store/store', () => ({
  appendBrowserReference: vi.fn(),
  setTaskBrowserUrl: vi.fn(),
  setActiveTask: vi.fn(),
  setTaskFocusedPanel: vi.fn(),
}));
const disposers: Array<() => void> = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function mount() {
  const listeners = new Map<string, (value: unknown) => void>();
  Object.assign(window, {
    electron: {
      ipcRenderer: {
        on: (channel: string, listener: (value: unknown) => void) => {
          listeners.set(channel, listener);
          return () => listeners.delete(channel);
        },
      },
    },
  });
  const container = document.createElement('div');
  document.body.append(container);
  disposers.push(render(() => <TaskBrowserPanel taskId="task-1" active={true} />, container));
  return { container, listeners };
}

it('opens a URL and routes only this preview’s picked reference to its task', async () => {
  const { container, listeners } = mount();
  await Promise.resolve();
  await Promise.resolve();
  const create = vi.mocked(invoke).mock.calls.find(([, args]) => args?.action === 'create')?.[1];
  const input = container.querySelector('input');
  if (!input) throw new Error('Address field missing');
  input.value = 'localhost:5173';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  container
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  expect(invoke).toHaveBeenCalledWith(IPC.BrowserCommand, {
    id: create?.id,
    action: 'navigate',
    url: 'localhost:5173',
  });
  const state = {
    id: create?.id,
    url: 'http://localhost:5173/',
    loading: false,
    picking: false,
    canGoBack: false,
    canGoForward: false,
    error: null,
    reference: 'Selected #save',
  };
  listeners.get(IPC.BrowserState)?.({ ...state, id: 'another-preview' });
  expect(appendBrowserReference).not.toHaveBeenCalled();
  listeners.get(IPC.BrowserState)?.(state);
  expect(appendBrowserReference).toHaveBeenCalledWith('task-1', 'Selected #save');
});

it('shows navigation failures and closes the native view on unmount', async () => {
  const { container } = mount();
  await Promise.resolve();
  await Promise.resolve();
  vi.mocked(invoke).mockRejectedValueOnce(new Error('Invalid address'));
  container
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await Promise.resolve();
  await Promise.resolve();
  expect(container.textContent).toContain('Invalid address');
  disposers.pop()?.();
  expect(invoke).toHaveBeenCalledWith(
    IPC.BrowserCommand,
    expect.objectContaining({ action: 'close' }),
  );
});
