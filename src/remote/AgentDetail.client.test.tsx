import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { AgentDetail } from './AgentDetail';
import { sendInput } from './ws';

const terminalMocks = vi.hoisted(() => ({
  scrollLines: vi.fn(),
  scrollback: undefined as ((data: string, cols: number, rows: number) => void) | undefined,
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: true };
    options = {};
    buffer = { active: { length: 0, viewportY: 0, baseY: 0, getLine: () => undefined } };
    open() {}
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
    }
    onScroll() {
      return { dispose() {} };
    }
    onWriteParsed() {
      return { dispose() {} };
    }
    dispose() {}
    reset() {}
    write(_data: Uint8Array, callback?: () => void) {
      callback?.();
    }
    scrollLines(lines: number) {
      terminalMocks.scrollLines(lines);
    }
    scrollToBottom() {}
  },
}));
vi.mock('./ws', () => ({
  agents: () => [
    {
      agentId: 'a1',
      taskId: 't1',
      taskName: 'First task',
      status: 'running',
      attention: 'needs_input',
    },
  ],
  status: () => 'connected',
  canControl: () => true,
  reconnect: vi.fn(),
  subscribeAgent: vi.fn(),
  unsubscribeAgent: vi.fn(),
  sendInput: vi.fn(),
  onOutput: () => () => {},
  onScrollback: (_id: string, callback: (data: string, cols: number, rows: number) => void) => {
    terminalMocks.scrollback = callback;
    return () => {};
  },
}));
vi.mock('./api', () => ({
  fetchNotes: vi.fn().mockResolvedValue('Notes from desktop'),
  saveNotes: vi.fn(),
  ApiError: class extends Error {},
}));

let host: HTMLDivElement;
let dispose: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  dispose?.();
  host.remove();
  vi.restoreAllMocks();
});
function mount() {
  dispose = render(
    () => (
      <AgentDetail
        agentId="a1"
        taskName="First task"
        onBack={() => {}}
        onNeedsPairing={() => {}}
        onNextTask={() => {}}
      />
    ),
    host,
  );
}
function composer() {
  const field = host.querySelector<HTMLTextAreaElement>('[aria-label="Message agent"]');
  if (!field) throw new Error('Missing composer');
  return field;
}
function type(text: string) {
  composer().value = text;
  composer().dispatchEvent(new Event('input', { bubbles: true }));
}
function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === text);
  if (!button) throw new Error(`Missing button: ${text}`);
  button.click();
}

describe('phone reply composer', () => {
  it('resizes a restored multiline reply after returning from Notes', async () => {
    vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockReturnValue(120);
    localStorage.setItem('parallel-mobile:reply:a1', 'First line\nSecond line\nThird line');
    mount();
    await vi.waitFor(() => expect(composer().style.height).toBe('120px'));
    click('Notes');
    click('Read');
    await vi.waitFor(() => expect(composer().style.height).toBe('120px'));
    expect(composer().value).toBe('First line\nSecond line\nThird line');
  });
  it('preserves the draft until accepted and does not submit on plain Enter', async () => {
    let accept!: () => void;
    vi.mocked(sendInput).mockReturnValue(
      new Promise((resolve) => {
        accept = resolve;
      }),
    );
    mount();
    type('First line\nSecond line');
    composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(sendInput).not.toHaveBeenCalled();
    click('Send');
    expect(composer().value).toBe('First line\nSecond line');
    expect(composer().disabled).toBe(true);
    expect(sendInput).toHaveBeenCalledWith('a1', '\x1b[200~First line\nSecond line\x1b[201~', true);
    accept();
    await vi.waitFor(() => expect(composer().value).toBe(''));
    expect(localStorage.getItem('parallel-mobile:reply:a1')).toBeNull();
    expect(host.textContent).toContain('Accepted by terminal');
  });
  it('keeps a failed draft and restores it when reopening the task', async () => {
    vi.mocked(sendInput).mockRejectedValue(new Error('Delivery could not be confirmed'));
    mount();
    type('Do not lose this');
    click('Send');
    await vi.waitFor(() => expect(host.textContent).toContain('Delivery could not be confirmed'));
    expect(composer().value).toBe('Do not lose this');
    dispose();
    mount();
    expect(composer().value).toBe('Do not lose this');
  });
  it('retains an empty notes draft instead of reloading the deleted text', async () => {
    mount();
    click('Notes');
    await vi.waitFor(() =>
      expect(host.querySelector<HTMLTextAreaElement>('#task-notes')?.value).toBe(
        'Notes from desktop',
      ),
    );
    const notes = host.querySelector<HTMLTextAreaElement>('#task-notes');
    if (!notes) throw new Error('Missing notes');
    notes.value = '';
    notes.dispatchEvent(new Event('input', { bubbles: true }));
    dispose();
    mount();
    click('Notes');
    expect(host.querySelector<HTMLTextAreaElement>('#task-notes')?.value).toBe('');
    expect(host.textContent).toContain('Draft saved on this phone');
  });
});

describe('phone terminal viewport', () => {
  function viewport() {
    const scroller = host.querySelector<HTMLDivElement>('.mobile-terminal-scroll');
    const content = host.querySelector<HTMLDivElement>('.mobile-terminal');
    if (!scroller || !content) throw new Error('Missing terminal viewport');
    let top = 0;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 300 },
      scrollTop: {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          top = Math.max(0, Math.min(900, value));
        },
      },
    });
    return { scroller, content };
  }
  function touch(target: HTMLElement, type: string, x: number, y: number, count = 1) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', {
      value: Array.from({ length: count }, () => ({ clientX: x, clientY: y })),
    });
    target.dispatchEvent(event);
    return event;
  }

  it('pans the desktop grid before scrolling history and shields gestures from xterm', () => {
    localStorage.setItem('parallel-mobile:output-view', 'terminal');
    mount();
    const { scroller, content } = viewport();
    const xtermGesture = vi.fn();
    document.addEventListener('touchmove', xtermGesture);
    try {
      touch(content, 'touchstart', 100, 100);
      const move = touch(content, 'touchmove', 50, 50);
      expect(scroller.scrollLeft).toBe(50);
      expect(scroller.scrollTop).toBe(50);
      expect(terminalMocks.scrollLines).not.toHaveBeenCalled();
      expect(move.defaultPrevented).toBe(true);
      expect(xtermGesture).not.toHaveBeenCalled();
      scroller.scrollTop = 900;
      touch(content, 'touchmove', 50, 0);
      expect(terminalMocks.scrollLines).toHaveBeenCalledWith(2);
      expect(touch(content, 'touchmove', 50, 0, 2).defaultPrevented).toBe(false);
    } finally {
      document.removeEventListener('touchmove', xtermGesture);
    }
  });

  it('opens a persisted Terminal view at the latest rows without yanking a scrolled reader on reconnect', async () => {
    localStorage.setItem('parallel-mobile:output-view', 'terminal');
    mount();
    const { scroller } = viewport();
    terminalMocks.scrollback?.('', 100, 60);
    await vi.waitFor(() => expect(scroller.scrollTop).toBe(900));
    scroller.scrollTop = 120;
    scroller.dispatchEvent(new Event('scroll'));
    terminalMocks.scrollback?.('', 100, 60);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(scroller.scrollTop).toBe(120);
  });
});
