import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { IPC } from './channels.js';

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  view: vi.fn(),
  partition: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: mocks.handle, removeHandler: mocks.removeHandler },
  WebContentsView: mocks.view,
  session: { fromPartition: mocks.partition },
}));
import { isBrowserCloseShortcut, registerBrowserHandlers } from './browser.js';

function fixture() {
  const frame = {};
  const owner = Object.assign(new EventEmitter(), {
    mainFrame: frame,
    send: vi.fn(),
    isDestroyed: () => false,
    getZoomFactor: () => 1,
    focus: vi.fn(),
  });
  const win = Object.assign(new EventEmitter(), {
    webContents: owner,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    getContentBounds: () => ({ width: 1000, height: 800 }),
  });
  registerBrowserHandlers(win as unknown as BrowserWindow);
  const handlers = new Map<string, (event: IpcMainInvokeEvent, args: unknown) => unknown>(
    mocks.handle.mock.calls.map(([name, fn]) => [name, fn]),
  );
  const event = { sender: owner, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const command = (args: unknown, e = event) => handlers.get(IPC.BrowserCommand)?.(e, args);
  const bounds = (value: unknown) =>
    handlers.get(IPC.BrowserBounds)?.(event, { id: 'preview-1', bounds: value });
  return { win, owner, command, bounds };
}

function guest() {
  const frame = {};
  const wc = Object.assign(new EventEmitter(), {
    mainFrame: frame,
    ipc: new EventEmitter(),
    loadURL: vi.fn().mockResolvedValue(undefined),
    getURL: () => 'http://localhost:5173/',
    isLoading: () => false,
    isDestroyed: () => false,
    navigationHistory: {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: vi.fn(),
      goForward: vi.fn(),
    },
    send: vi.fn(),
    close: vi.fn(),
    reload: vi.fn(),
    focus: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  });
  return { webContents: wc, setBounds: vi.fn(), setVisible: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.partition.mockReturnValue({
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    on: vi.fn(),
  });
  mocks.view.mockImplementation(function () {
    return guest();
  });
});

describe('task browser IPC', () => {
  it('recognizes the platform close chord without accepting extra modifiers', () => {
    const input = {
      type: 'keyDown',
      key: 'w',
      control: true,
      meta: false,
      alt: false,
      shift: false,
    };
    expect(isBrowserCloseShortcut(input, 'linux')).toBe(true);
    expect(isBrowserCloseShortcut({ ...input, control: false, meta: true }, 'darwin')).toBe(true);
    expect(isBrowserCloseShortcut({ ...input, shift: true }, 'linux')).toBe(false);
    expect(isBrowserCloseShortcut({ ...input, meta: true }, 'linux')).toBe(false);
  });

  it('refuses commands from guests and subframes', () => {
    const { command } = fixture();
    expect(() =>
      command({ id: 'preview-1', action: 'create' }, {
        sender: {},
        senderFrame: {},
      } as IpcMainInvokeEvent),
    ).toThrow();
    expect(mocks.view).not.toHaveBeenCalled();
  });
  it('isolates previews and refuses unsafe navigations and popups', () => {
    const { command } = fixture();
    command({ id: 'preview-1', action: 'create' });
    const prefs = mocks.view.mock.calls[0][0].webPreferences;
    expect(prefs).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false });
    expect(prefs.preload).toContain('browser-preload.cjs');
    const view = mocks.view.mock.results[0].value as ReturnType<typeof guest>;
    expect(() =>
      command({ id: 'preview-1', action: 'navigate', url: 'file:///etc/passwd' }),
    ).toThrow();
    expect(view.webContents.loadURL).not.toHaveBeenCalled();
    const preventDefault = vi.fn();
    view.webContents.emit('will-navigate', { preventDefault }, 'file:///etc/passwd');
    expect(preventDefault).toHaveBeenCalled();
    expect(
      view.webContents.setWindowOpenHandler.mock.calls[0][0]({ url: 'https://example.com' }),
    ).toEqual({ action: 'deny' });
  });
  it('reports the final URL after a redirect', () => {
    const { command, owner } = fixture();
    command({ id: 'preview-1', action: 'create' });
    const wc = (mocks.view.mock.results[0].value as ReturnType<typeof guest>).webContents;
    wc.emit('did-start-navigation', {}, 'http://localhost:5173/redirect', false, true);
    wc.emit('did-navigate', {}, 'http://localhost:5173/next');
    expect(owner.send).toHaveBeenLastCalledWith(
      IPC.BrowserState,
      expect.objectContaining({ url: 'http://localhost:5173/next' }),
    );
  });

  it('forwards guest focus without moving keyboard focus to the app', () => {
    const { command, owner } = fixture();
    command({ id: 'preview-1', action: 'create' });
    const wc = (mocks.view.mock.results[0].value as ReturnType<typeof guest>).webContents;
    wc.emit('focus');
    expect(owner.send).toHaveBeenLastCalledWith(
      IPC.BrowserState,
      expect.objectContaining({ id: 'preview-1', focused: true }),
    );
    expect(owner.focus).not.toHaveBeenCalled();
    wc.emit('did-stop-loading');
    expect(owner.send.mock.lastCall?.[1].focused).toBeUndefined();
  });

  it('forwards a close shortcut from a visible guest and suppresses repeats', () => {
    const { command, owner, bounds } = fixture();
    command({ id: 'preview-1', action: 'create' });
    bounds({ x: 10, y: 20, width: 400, height: 300 });
    const wc = (mocks.view.mock.results[0].value as ReturnType<typeof guest>).webContents;
    const shortcut = {
      type: 'keyDown',
      key: 'w',
      control: process.platform !== 'darwin',
      meta: process.platform === 'darwin',
      alt: false,
      shift: false,
      isAutoRepeat: false,
    };
    const event = { preventDefault: vi.fn() };

    wc.emit('before-input-event', event, shortcut);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(owner.send).toHaveBeenLastCalledWith(
      IPC.BrowserState,
      expect.objectContaining({ id: 'preview-1', closeRequested: true }),
    );

    owner.send.mockClear();
    wc.emit('before-input-event', event, { ...shortcut, isAutoRepeat: true });
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(owner.send).not.toHaveBeenCalled();
  });

  it('only forwards a picker result from the armed guest main frame', () => {
    const { command, owner, bounds } = fixture();
    command({ id: 'preview-1', action: 'create' });
    bounds({ x: 10, y: 20, width: 400, height: 300 });
    const wc = (mocks.view.mock.results[0].value as ReturnType<typeof guest>).webContents;
    const element = { selector: '#save', text: 'Save', html: '<button>Save</button>' };
    wc.ipc.emit('browser:pick-result', { senderFrame: wc.mainFrame }, element);
    expect(owner.send.mock.calls.some(([, state]) => state.reference)).toBe(false);
    command({ id: 'preview-1', action: 'pick' });
    wc.ipc.emit('browser:pick-result', { senderFrame: {} }, element);
    expect(owner.send.mock.calls.some(([, state]) => state.reference)).toBe(false);
    wc.ipc.emit('browser:pick-result', { senderFrame: wc.mainFrame }, element);
    expect(owner.send.mock.calls.some(([, state]) => state.reference?.includes('#save'))).toBe(
      true,
    );
    owner.send.mockClear();
    wc.ipc.emit('browser:pick-result', { senderFrame: wc.mainFrame }, element);
    expect(owner.send).not.toHaveBeenCalled();
  });
  it('closes guests after the parent window native view is already destroyed', () => {
    const { command, win } = fixture();
    command({ id: 'preview-1', action: 'create' });
    const wc = (mocks.view.mock.results[0].value as ReturnType<typeof guest>).webContents;
    Object.defineProperty(win, 'contentView', {
      get() {
        throw new Error('Object has been destroyed');
      },
    });
    expect(() => win.emit('closed')).not.toThrow();
    expect(wc.close).toHaveBeenCalled();
  });

  it('hides and releases native web contents on close and renderer reload', () => {
    const { command, bounds, win, owner } = fixture();
    command({ id: 'preview-1', action: 'create' });
    const view = mocks.view.mock.results[0].value as ReturnType<typeof guest>;
    bounds({ x: 10, y: 20, width: 400, height: 300 });
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
    bounds(null);
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
    command({ id: 'preview-1', action: 'close' });
    expect(view.webContents.close).toHaveBeenCalled();
    expect(win.contentView.removeChildView).toHaveBeenCalledWith(view);
    command({ id: 'preview-1', action: 'create' });
    const next = mocks.view.mock.results[1].value as ReturnType<typeof guest>;
    owner.emit('did-start-navigation', {}, 'file:///app.html', false, true);
    expect(next.webContents.close).toHaveBeenCalled();
  });
});
