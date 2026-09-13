import { render } from 'solid-js/web';
import { reconcile } from 'solid-js/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import { getPanelUserSize, setPanelUserSize } from '../store/ui';
import { ResizablePanel, type PanelChild } from './ResizablePanel';

vi.mock('../store/store', async () => import('../store/ui'));

let dispose: (() => void) | undefined;

beforeEach(() => setStore('panelUserSize', reconcile({})));
afterEach(() => {
  window.dispatchEvent(new MouseEvent('mouseup'));
  dispose?.();
  document.body.replaceChildren();
});

function mount(children: PanelChild[], absorberIds: string[], sizes: number[]) {
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(
    () => (
      <ResizablePanel
        direction="vertical"
        persistKey="test"
        absorberIds={absorberIds}
        children={children}
      />
    ),
    host,
  );
  const cells = [...host.querySelectorAll<HTMLElement>('.rp-cell')];
  cells.forEach((cell, index) => {
    // happy-dom has no layout engine; supply the browser's measured sizes.
    cell.getBoundingClientRect = () => new DOMRect(0, 0, 600, sizes[index]);
  });
  return {
    cells,
    start(index: number) {
      host
        .querySelectorAll('.resize-handle')
        [index].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientY: 200 }));
    },
    move(delta: number) {
      window.dispatchEvent(new MouseEvent('mousemove', { clientY: 200 + delta }));
    },
    release() {
      window.dispatchEvent(new MouseEvent('mouseup'));
    },
  };
}

const notes: PanelChild = {
  id: 'notes',
  minSize: 60,
  absorberWeight: 0.25,
  content: () => 'Notes',
};
const terminal: PanelChild = { id: 'terminal', minSize: 80, content: () => 'Terminal' };
const shell: PanelChild = { id: 'shell', minSize: 28, content: () => 'Shell' };

describe('ResizablePanel drag release', () => {
  it.each([0, 1])('keeps the split after dragging handle %i beside a collapsed shell', (handle) => {
    const sizes = [120, 28, 480];
    const panel = mount(
      [notes, { ...shell, noPin: () => true }, terminal],
      ['notes', 'terminal'],
      sizes,
    );
    panel.start(handle);
    panel.move(50);
    expect(panel.cells[0].style.flexBasis).toBe('170px');
    expect(panel.cells[2].style.flexBasis).toBe('430px');
    sizes[0] = 170;
    sizes[2] = 430;
    panel.release();

    expect(getPanelUserSize('test:notes')).toBe(170);
    expect(getPanelUserSize('test:terminal')).toBe(430);
    expect(getPanelUserSize('test:shell')).toBeUndefined();
    expect(
      Number(panel.cells[0].style.flexGrow) / Number(panel.cells[2].style.flexGrow),
    ).toBeCloseTo(170 / 430);
  });

  it('preserves both absorbers when resizing an expanded shell', () => {
    const sizes = [120, 160, 480];
    const panel = mount([notes, shell, terminal], ['notes', 'terminal'], sizes);
    panel.start(1);
    panel.move(60);
    expect(panel.cells[0].style.flexBasis).toBe('120px');
    sizes[1] = 220;
    sizes[2] = 420;
    panel.release();

    expect(getPanelUserSize('test:notes')).toBe(120);
    expect(getPanelUserSize('test:shell')).toBe(220);
    expect(getPanelUserSize('test:terminal')).toBe(420);
  });

  it.each([0, 1])(
    'clamps a drag past the minimum beside a collapsed shell at handle %i',
    (handle) => {
      const sizes = [120, 28, 480];
      const panel = mount(
        [notes, { ...shell, noPin: () => true }, terminal],
        ['notes', 'terminal'],
        sizes,
      );
      panel.start(handle);
      panel.move(-1000);
      expect(panel.cells[0].style.flexBasis).toBe('60px');
      expect(panel.cells[2].style.flexBasis).toBe('540px');
      sizes[0] = 60;
      sizes[2] = 540;
      panel.release();

      expect(getPanelUserSize('test:notes')).toBe(60);
      expect(getPanelUserSize('test:terminal')).toBe(540);
    },
  );

  it('uses the current sizes of every absorber after a previous saved split', () => {
    setPanelUserSize('test:notes', 100);
    setPanelUserSize('test:terminal', 300);
    const sizes = [200, 600, 100];
    const prompt: PanelChild = { id: 'prompt', minSize: 54, content: () => 'Prompt' };
    const panel = mount([notes, terminal, prompt], ['notes', 'terminal'], sizes);
    panel.start(1);
    panel.move(-80);
    sizes[1] = 520;
    sizes[2] = 180;
    panel.release();

    expect(getPanelUserSize('test:notes')).toBe(200);
    expect(getPanelUserSize('test:terminal')).toBe(520);
    expect(getPanelUserSize('test:prompt')).toBe(180);
  });

  it('does not pin content or change proportions on a click without movement', () => {
    const panel = mount([notes, shell, terminal], ['notes', 'terminal'], [120, 160, 480]);
    panel.start(0);
    panel.release();

    expect(getPanelUserSize('test:notes')).toBeUndefined();
    expect(getPanelUserSize('test:shell')).toBeUndefined();
    expect(getPanelUserSize('test:terminal')).toBeUndefined();
  });

  it('keeps a sole absorber flexible and clamps its neighbor at the minimum', () => {
    const sizes = [160, 480];
    const panel = mount([shell, terminal], ['terminal'], sizes);
    panel.start(0);
    panel.move(1000);
    sizes[0] = 560;
    sizes[1] = 80;
    panel.release();

    expect(getPanelUserSize('test:shell')).toBe(560);
    expect(getPanelUserSize('test:terminal')).toBeUndefined();
    expect(panel.cells[1].style.flexGrow).toBe('1');
  });
});
