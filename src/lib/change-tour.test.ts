import { describe, expect, it } from 'vitest';
import { buildChangeTourPrompts, parseChangeTour, getChangeTourSelection } from './change-tour';
import { parseUnifiedDiff } from './unified-diff-parser';
import { CHANGE_TOUR_PROMPT_LIMIT } from '../../electron/shared/change-tour-limits';

const diff = 'diff --git a/file.ts b/file.ts\n@@ -1 +1 @@\n-old\n+new\n';
const files = parseUnifiedDiff(diff);
const stop = {
  title: 'Behavior',
  explanation: 'Changes the returned value.',
  locations: [{ filePath: 'file.ts', line: 1 }],
};

describe('change tours', () => {
  it.each(['main', 'master', 'develop'])('defaults %s to uncommitted changes', (branch) => {
    expect(getChangeTourSelection(branch, 'auto', 'abc123')).toBe('uncommitted');
    expect(getChangeTourSelection(branch, 'selection', null)).toBeNull();
    expect(getChangeTourSelection(branch, 'selection', 'abc123')).toBe('abc123');
  });
  it.each(['feature/tour', 'release/main', 'develop-fix', undefined])(
    'defaults %s to the whole branch independently of browsing',
    (branch) => {
      expect(getChangeTourSelection(branch, 'auto', 'abc123')).toBeNull();
      expect(getChangeTourSelection(branch, 'auto', 'uncommitted')).toBeNull();
      expect(getChangeTourSelection(branch, 'selection', 'uncommitted')).toBe('uncommitted');
    },
  );
  it.each([
    ['Here is the tour:\n', '\nThis tour covers the supplied change.'],
    ['', '\nNote: tests were not executed.'],
    ['Here is the tour:\n```json\n', '\n```\nSee [the code](file.ts).'],
  ])('accepts a complete tour surrounded by commentary (%s)', (prefix, suffix) => {
    expect(parseChangeTour(prefix + JSON.stringify({ stops: [stop] }) + suffix, files)).toEqual([
      stop,
    ]);
  });

  it('ignores braces and escaped quotes inside JSON strings when extracting a tour', () => {
    const withCode = { ...stop, explanation: 'Handles { nested: ["quoted"] } and \\ escapes.' };
    expect(parseChangeTour(JSON.stringify({ stops: [withCode] }) + '\nDone.', files)).toEqual([
      withCode,
    ]);
  });

  it.each([
    JSON.stringify({ stops: [stop] }) + '\n' + JSON.stringify({ stops: [stop] }),
    JSON.stringify({ stops: [stop] }) + '\n{"stops":[',
    '{"stops":[' + JSON.stringify(stop) + ',]}\nDone.',
    '{"stops":[' + JSON.stringify(stop),
  ])(
    'rejects ambiguous, truncated, or malformed output without a raw JSON exception',
    (response) => {
      expect(() => parseChangeTour(response, files)).toThrow(/provider.*retry the tour/i);
    },
  );

  it('still validates code references after extracting wrapped JSON', () => {
    const invalid = { ...stop, locations: [{ filePath: 'invented.ts', line: 1 }] };
    expect(() =>
      parseChangeTour('Tour:\n' + JSON.stringify({ stops: [invalid] }) + '\nDone.', files),
    ).toThrow('outside this diff');
  });

  it('accepts valid structured stops, including fenced JSON', () => {
    expect(
      parseChangeTour('```json\n' + JSON.stringify({ stops: [stop] }) + '\n```', files),
    ).toEqual([stop]);
  });
  it('rejects invented paths and lines', () => {
    for (const location of [
      { filePath: 'invented.ts', line: 1 },
      { filePath: 'file.ts', line: 999 },
      { filePath: 'file.ts', line: -1 },
    ]) {
      expect(() =>
        parseChangeTour(JSON.stringify({ stops: [{ ...stop, locations: [location] }] }), files),
      ).toThrow();
    }
  });
  it('rejects malformed output instead of displaying an unlinked explanation', () => {
    for (const response of ['not json', '{}', '{"stops":[]}', '{"stops":[null]}'])
      expect(() => parseChangeTour(response, files)).toThrow();
  });
  it('includes the exact diff in one request when it fits', () => {
    const [prompt] = buildChangeTourPrompts('Task', diff);
    expect(prompt).toContain(JSON.stringify(diff));
    expect(prompt).toContain('never claim they passed');
    expect(prompt).toContain('4-6 concise stops for the whole change');
    expect(buildChangeTourPrompts('Task', diff)).toHaveLength(1);
    expect(() => buildChangeTourPrompts('Task', '')).toThrow('no code changes');
  });

  it('fits a representative 600-line change into one request under the backend limit', () => {
    const removed = Array.from({ length: 300 }, (_, i) => `-const old${i} = "${'a'.repeat(100)}";`);
    const added = Array.from({ length: 300 }, (_, i) => `+const next${i} = "${'b'.repeat(100)}";`);
    const raw = `diff --git a/file.ts b/file.ts\n@@ -1,300 +1,300 @@\n${[...removed, ...added].join('\n')}\n`;
    const prompts = buildChangeTourPrompts('Task', raw);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].length).toBeGreaterThan(50_000);
    expect(prompts[0].length).toBeLessThanOrEqual(CHANGE_TOUR_PROMPT_LIMIT);
    expect(prompts[0]).toContain(JSON.stringify(raw));
  });

  it('keeps a multi-file change near the tour budget in one coherent request', () => {
    const blocks = Array.from(
      { length: 4 },
      (_, i) =>
        `diff --git a/file${i}.ts b/file${i}.ts\n@@ -1 +1 @@\n-old\n+${'x'.repeat(Math.floor(CHANGE_TOUR_PROMPT_LIMIT / 5))}\n`,
    );
    const raw = blocks.join('');
    const prompts = buildChangeTourPrompts('Task', raw);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(JSON.stringify(raw));
    expect(prompts[0]).toContain('4-6 concise stops for the whole change');
  });

  it('splits many files into bounded requests without omitting later files', () => {
    const blocks = Array.from(
      { length: 100 },
      (_, i) =>
        `diff --git a/file${i}.ts b/file${i}.ts\n@@ -1 +1 @@\n-${'a'.repeat(Math.ceil(CHANGE_TOUR_PROMPT_LIMIT / 100))}\n+file${i} ${'b'.repeat(Math.ceil(CHANGE_TOUR_PROMPT_LIMIT / 100))}\n`,
    );
    const prompts = buildChangeTourPrompts('Task', blocks.join(''));
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts.every((prompt) => prompt.length <= CHANGE_TOUR_PROMPT_LIMIT)).toBe(true);
    expect(prompts.every((prompt) => prompt.includes('1-2 concise stops for this part'))).toBe(
      true,
    );
    for (const block of blocks) {
      expect(prompts.some((prompt) => prompt.includes(JSON.stringify(block).slice(1, -1)))).toBe(
        true,
      );
    }
  });

  it('splits an oversized file while preserving original line numbers and all contents', () => {
    const lines = Array.from(
      { length: Math.ceil(CHANGE_TOUR_PROMPT_LIMIT / 50) },
      (_, i) => `line-${i}-${'\\"'.repeat(25)}`,
    );
    const raw = `diff --git a/large.ts b/large.ts\nnew file mode 100644\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => '+' + line).join('\n')}\n`;
    const prompts = buildChangeTourPrompts('Task', raw);
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts.every((prompt) => prompt.length <= CHANGE_TOUR_PROMPT_LIMIT)).toBe(true);
    const contexts = prompts.map(
      (prompt) => JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as string,
    );
    expect(contexts.every((context) => !context.includes('old:'))).toBe(true);
    const records = contexts.flatMap((context) =>
      parseUnifiedDiff(context).flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines)),
    );
    expect(records.map((line) => line.content)).toEqual(lines);
    expect(records.map((line) => line.newLine)).toEqual(lines.map((_, i) => i + 1));
    expect(contexts.every((context) => context.includes('new file mode 100644'))).toBe(true);
  });

  it('preserves mixed additions, deletions and context when splitting hunks', () => {
    const content = 'x'.repeat(Math.ceil(CHANGE_TOUR_PROMPT_LIMIT / 300));
    const body = Array.from(
      { length: 600 },
      (_, i) => `${['-', '+', ' '][i % 3]}${i}${content}\n`,
    ).join('');
    const raw = `diff --git a/file.ts b/file.ts\n@@ -40,400 +60,400 @@\n${body}`;
    const prompts = buildChangeTourPrompts('Task', raw);
    expect(prompts.length).toBeGreaterThan(1);
    const lines = prompts.flatMap((prompt) => {
      expect(prompt.length).toBeLessThanOrEqual(CHANGE_TOUR_PROMPT_LIMIT);
      const context = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as string;
      return parseUnifiedDiff(context).flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines));
    });
    expect(lines).toEqual(parseUnifiedDiff(raw)[0].hunks[0].lines);
  });

  it('handles a single very long line using labeled fragments instead of truncation', () => {
    const content = '\u0000'.repeat(CHANGE_TOUR_PROMPT_LIMIT);
    const raw = `diff --git a/long.ts b/long.ts\n@@ -0,0 +1,2 @@\n+${content}\n+tail\n`;
    const prompts = buildChangeTourPrompts('Task', raw);
    expect(prompts.every((prompt) => prompt.length <= CHANGE_TOUR_PROMPT_LIMIT)).toBe(true);
    const contexts = prompts.map(
      (prompt) => JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as string,
    );
    const fragments = contexts
      .join('\n')
      .split('\n')
      .filter((line) => line.startsWith('old:'));
    expect(
      fragments
        .map(
          (record) =>
            JSON.parse(record.replace(/^old:- new:1 add fragment \d+\/\d+ /, '')) as string,
        )
        .join(''),
    ).toBe(content);
    const tail = contexts.flatMap((context) =>
      parseUnifiedDiff(context).flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines)),
    );
    expect(tail).toEqual([{ type: 'add', content: 'tail', oldLine: null, newLine: 2 }]);
  });

  it('preserves old-side ranges when splitting a deleted file', () => {
    const body = Array.from(
      { length: 600 },
      (_, i) => `-${i}${'x'.repeat(Math.ceil(CHANGE_TOUR_PROMPT_LIMIT / 300))}\n`,
    ).join('');
    const raw = `diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n@@ -1,600 +0,0 @@\n${body}`;
    const prompts = buildChangeTourPrompts('Task', raw);
    expect(prompts.length).toBeGreaterThan(1);
    const lines = prompts.flatMap((prompt) => {
      const context = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as string;
      const file = parseUnifiedDiff(context)[0];
      expect(file.status).toBe('D');
      return file.hunks.flatMap((hunk) => hunk.lines);
    });
    expect(lines).toEqual(parseUnifiedDiff(raw)[0].hunks[0].lines);
  });
});
