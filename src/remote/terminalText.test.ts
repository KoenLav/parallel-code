import { describe, it, expect } from 'vitest';
import type { IBuffer } from '@xterm/xterm';
import { terminalText, messageForTerminal } from './terminalText';

function buffer(rows: { text: string; isWrapped?: boolean }[]): IBuffer {
  return {
    length: rows.length,
    getLine: (index: number) =>
      rows[index]
        ? {
            isWrapped: rows[index].isWrapped ?? false,
            translateToString: (trim: boolean) =>
              trim ? rows[index].text.trimEnd() : rows[index].text,
          }
        : undefined,
  } as unknown as IBuffer;
}

describe('phone reading view', () => {
  it('joins soft-wrapped terminal rows without losing spaces between words', () => {
    const text = terminalText(
      buffer([
        { text: 'Please review ' },
        { text: 'the changes', isWrapped: true },
        { text: 'Then run tests.   ' },
        { text: '' },
      ]),
    );
    expect(text).toBe('Please review the changes\nThen run tests.');
  });
  it('bounds the snapshot while preserving hard line breaks', () => {
    expect(terminalText(buffer([{ text: 'old' }, { text: 'one' }, { text: 'two' }]), 2)).toBe(
      'one\ntwo',
    );
  });
});

describe('composed phone replies', () => {
  it('preserves multiline text within bracketed paste', () => {
    expect(messageForTerminal('first\r\nsecond', true)).toBe('\x1b[200~first\nsecond\x1b[201~');
  });
  it('does not accidentally submit each line in terminals without paste support', () => {
    expect(messageForTerminal('first\nsecond', false)).toBe('first second');
  });
  it('removes pasted control characters and refuses an empty message', () => {
    expect(messageForTerminal('\x03hello\x1b', true)).toBe('\x1b[200~hello\x1b[201~');
    expect(messageForTerminal(' \n\x03 ', true)).toBe('');
  });
});
