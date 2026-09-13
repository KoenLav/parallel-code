import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import type { BrowserWindow } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHANGE_TOUR_TIMEOUT_MS, CHANGE_TOUR_PROMPT_LIMIT } from '../shared/change-tour-limits.js';

vi.mock('child_process', () => ({ spawn: vi.fn() }));
vi.mock('./pty.js', () => ({ validateCommand: vi.fn(), ENV_BLOCK_LIST: new Set<string>() }));
vi.mock('./env-file.js', () => ({ loadEnvFile: () => ({}) }));
vi.mock('./ask-code-minimax.js', () => ({
  askAboutCodeMinimax: vi.fn(),
  cancelAskAboutCodeMinimax: vi.fn(),
  isMinimaxRequestActive: () => false,
}));
import { askAboutCode } from './ask-code.js';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('Claude code Q&A deadlines', () => {
  it.each([undefined, 'tour'] as const)('uses the correct deadline for purpose %s', (purpose) => {
    vi.useFakeTimers();
    const proc = Object.assign(new EventEmitter(), {
      stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValue(proc as unknown as ChildProcess);
    const send = vi.fn();
    const win = { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow;
    askAboutCode(win, {
      requestId: purpose ?? 'question',
      channelId: 'test',
      prompt: 'Explain this code',
      cwd: '/tmp',
      provider: 'claude',
      purpose,
    });
    expect(proc.stdin.end).toHaveBeenCalledTimes(purpose === 'tour' ? 1 : 0);
    expect(spawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining([
        purpose === 'tour'
          ? 'Return exactly one JSON object matching the requested tour schema. No markdown, commentary, or additional JSON objects.'
          : 'Answer concisely about the selected code. Use markdown.',
      ]),
      expect.any(Object),
    );
    vi.advanceTimersByTime(120_000);
    if (purpose === 'tour') {
      expect(send).not.toHaveBeenCalled();
      expect(proc.kill).not.toHaveBeenCalled();
      vi.advanceTimersByTime(CHANGE_TOUR_TIMEOUT_MS - 120_000);
    }
    expect(send).toHaveBeenCalledWith('channel:test', {
      type: 'error',
      text: `Request timed out after ${purpose === 'tour' ? 5 : 2} minutes.`,
    });
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    proc.emit('close', null);
    expect(send.mock.calls.filter(([, message]) => message.type === 'done')).toHaveLength(1);
  });

  it('pipes a large tour to Claude and handles an early stdin failure once', () => {
    const proc = Object.assign(new EventEmitter(), {
      stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValue(proc as unknown as ChildProcess);
    const send = vi.fn();
    const win = { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow;
    const prompt = 'x'.repeat(CHANGE_TOUR_PROMPT_LIMIT);
    askAboutCode(win, {
      requestId: 'large-tour',
      channelId: 'test',
      prompt,
      cwd: '/tmp',
      purpose: 'tour',
    });
    expect(spawn).toHaveBeenCalledWith(
      'claude',
      expect.not.arrayContaining([prompt]),
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
    expect(proc.stdin.end).toHaveBeenCalledExactlyOnceWith(prompt);
    proc.stdin.emit('error', new Error('broken pipe'));
    proc.emit('close', 1);
    expect(send).toHaveBeenCalledWith('channel:test', {
      type: 'error',
      text: 'Could not send tour prompt: broken pipe',
    });
    expect(send.mock.calls.filter(([, message]) => message.type === 'done')).toHaveLength(1);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it.each([
    [undefined, 50_001],
    ['tour', CHANGE_TOUR_PROMPT_LIMIT + 1],
  ] as const)('rejects oversized prompts for purpose %s before spawning', (purpose, length) => {
    const win = { isDestroyed: () => false } as unknown as BrowserWindow;
    expect(() =>
      askAboutCode(win, {
        requestId: 'too-large',
        channelId: 'test',
        prompt: 'x'.repeat(length),
        cwd: '/tmp',
        purpose,
      }),
    ).toThrow(/Prompt too long/);
    expect(spawn).not.toHaveBeenCalled();
  });
});
