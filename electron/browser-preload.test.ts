import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { Window } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';

function setup() {
  const window = new Window();
  window.document.body.innerHTML =
    '<button id="save">Save</button><input type="password" value="secret">';
  const handlers = new Map<string, (_event: unknown, value: unknown) => void>();
  const send = vi.fn();
  runInNewContext(readFileSync(new URL('./browser-preload.cjs', import.meta.url), 'utf8'), {
    require: () => ({
      ipcRenderer: {
        on: (channel: string, cb: (_event: unknown, value: unknown) => void) =>
          handlers.set(channel, cb),
        send,
      },
    }),
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    CSS: window.CSS,
  });
  const pick = (selector: string, trusted = true) => {
    const event = new window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    Object.defineProperty(event, 'isTrusted', { value: trusted });
    window.document.querySelector(selector)?.dispatchEvent(event);
    return event;
  };
  return { window, send, pick, arm: () => handlers.get('browser:set-picking')?.({}, true) };
}

describe('isolated element picker', () => {
  it('captures an element and suppresses its normal click, then disarms', () => {
    const { arm, pick, send, window } = setup();
    arm();
    expect(pick('#save').defaultPrevented).toBe(true);
    expect(send).toHaveBeenCalledWith(
      'browser:pick-result',
      expect.objectContaining({ selector: '#save', text: 'Save' }),
    );
    pick('#save');
    expect(send).toHaveBeenCalledTimes(1);
    expect(window.document.querySelector('[data-parallel-picker]')).toBeNull();
  });
  it('ignores synthetic page events and never copies input values', () => {
    const { arm, pick, send } = setup();
    arm();
    pick('#save', false);
    expect(send).not.toHaveBeenCalled();
    pick('input');
    expect(JSON.stringify(send.mock.calls)).not.toContain('secret');
  });
  it('cancels on Escape without producing a reference', () => {
    const { arm, send, window } = setup();
    arm();
    window.document.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(send).toHaveBeenCalledWith('browser:pick-result', null);
  });
});
