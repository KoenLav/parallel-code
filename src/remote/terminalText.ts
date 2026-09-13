import type { IBuffer } from '@xterm/xterm';

/** Read parsed terminal cells, so cursor movement and ANSI codes aren't shown as text. */
export function terminalText(buffer: IBuffer, maxLines = 1000): string {
  const lines: string[] = [];
  for (let i = Math.max(0, buffer.length - maxLines); i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const text = line.translateToString(!buffer.getLine(i + 1)?.isWrapped);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines.join('\n').trimEnd();
}

export function messageForTerminal(text: string, bracketedPaste: boolean): string {
  // Clipboard controls must not escape the pasted region or submit midway.
  const clean = text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .trim();
  if (!clean) return '';
  return bracketedPaste ? `\x1b[200~${clean}\x1b[201~` : clean.replace(/\n/g, ' ');
}
