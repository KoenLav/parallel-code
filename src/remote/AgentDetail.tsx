import { onMount, onCleanup, createSignal, createEffect, untrack, Show, For } from 'solid-js';
import { Terminal } from '@xterm/xterm';
import { TERMINAL_SCROLL_OPTIONS, base64ToUint8Array } from '../lib/terminalConstants';
import { createTerminalHttpLinkHandler } from '../lib/terminalLinks';
import { fetchNotes, saveNotes, ApiError } from './api';
import { clearPairedToken } from './auth';
import { readLocal, writeLocal } from './storage';
import { agentStatusDisplay } from './attention';
import { terminalText, messageForTerminal } from './terminalText';
import { ConnectionBanner } from './ConnectionBanner';
import {
  subscribeAgent,
  unsubscribeAgent,
  onOutput,
  onScrollback,
  sendInput,
  agents,
  status,
  canControl,
} from './ws';

interface AgentDetailProps {
  agentId: string;
  taskName: string;
  onBack: () => void;
  onNeedsPairing: () => void;
  onNextTask: (taskId: string) => void;
}

const openRemoteHttpLink = createTerminalHttpLinkHandler({
  isMac: false,
  openExternal: (url) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
});

export function AgentDetail(props: AgentDetailProps) {
  let termContainer: HTMLDivElement | undefined;
  let outputArea: HTMLDivElement | undefined;
  let reading: HTMLDivElement | undefined;
  let terminalScroller: HTMLDivElement | undefined;
  let inputRef: HTMLTextAreaElement | undefined;
  let term: Terminal | undefined;
  let disposed = false;
  // The parent keys this component by agent ID.
  // eslint-disable-next-line solid/reactivity
  const draftKey = `reply:${props.agentId}`;
  // eslint-disable-next-line solid/reactivity
  const notesKey = `notes:${props.agentId}`;
  const [inputText, setInputText] = createSignal(readLocal(draftKey));
  const [sending, setSending] = createSignal(false);
  const [sendError, setSendError] = createSignal('');
  const [sent, setSent] = createSignal(false);
  const [showKeys, setShowKeys] = createSignal(false);
  const [view, setView] = createSignal<'output' | 'terminal' | 'notes'>(
    readLocal('output-view') === 'terminal' ? 'terminal' : 'output',
  );
  const [output, setOutput] = createSignal('');
  const [multilinePaste, setMultilinePaste] = createSignal(false);
  const [atBottom, setAtBottom] = createSignal(true);
  const [terminalBottom, setTerminalBottom] = createSignal(true);
  const [fontSize, setFontSize] = createSignal(
    Math.max(12, Math.min(24, Number(readLocal('terminal-font')) || 14)),
  );
  const [notesText, setNotesText] = createSignal(readLocal(notesKey));
  const [notesDirty, setNotesDirty] = createSignal(readLocal(`${notesKey}:dirty`) === 'true');
  const [notesLoading, setNotesLoading] = createSignal(false);
  const [notesSaving, setNotesSaving] = createSignal(false);
  const [notesError, setNotesError] = createSignal('');
  const [notesSaved, setNotesSaved] = createSignal(false);
  const agent = () => agents().find((a) => a.agentId === props.agentId);
  const taskId = () => agent()?.taskId;
  const display = () => agentStatusDisplay(agent() ?? { status: 'exited', attention: 'idle' });
  const nextTask = () =>
    agents().find(
      (a) =>
        a.agentId !== props.agentId && (a.attention === 'needs_input' || a.attention === 'error'),
    );

  createEffect(() => writeLocal(draftKey, inputText()));
  createEffect(() => {
    if (notesDirty()) {
      writeLocal(notesKey, notesText());
      writeLocal(`${notesKey}:dirty`, 'true');
    }
  });
  createEffect(() => {
    inputText();
    resizeComposer();
  });
  function resizeComposer() {
    if (inputRef) {
      inputRef.style.height = 'auto';
      inputRef.style.height = `${Math.min(160, inputRef.scrollHeight)}px`;
    }
  }

  function fitTerminal() {
    if (!term || !termContainer || !outputArea) return;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (context) context.font = `${fontSize()}px monospace`;
    const charWidth = context?.measureText('M').width ?? fontSize() * 0.61;
    term.options.fontSize = fontSize();
    const width = Math.ceil(term.cols * charWidth) + 16;
    termContainer.style.width = `${width}px`;
    termContainer.style.height = `${Math.ceil(term.rows * fontSize() * 1.2) + 8}px`;
  }

  function updateTerminalBottom() {
    if (!term || !terminalScroller) return;
    setTerminalBottom(
      term.buffer.active.viewportY >= term.buffer.active.baseY &&
        terminalScroller.scrollHeight - terminalScroller.scrollTop - terminalScroller.clientHeight <
          48,
    );
  }

  function jumpToLatest() {
    if (view() === 'terminal') {
      term?.scrollToBottom();
      if (terminalScroller) terminalScroller.scrollTop = terminalScroller.scrollHeight;
      setTerminalBottom(true);
    } else if (reading) {
      reading.scrollTop = reading.scrollHeight;
      setAtBottom(true);
    }
  }

  onMount(() => {
    if (!termContainer) return;
    term = new Terminal({
      cols: 80,
      rows: 24,
      fontSize: fontSize(),
      fontFamily: 'monospace',
      lineHeight: 1.2,
      theme: { background: '#0b0f14', foreground: '#dce7f1' },
      ...TERMINAL_SCROLL_OPTIONS,
      cursorBlink: false,
      disableStdin: true,
      linkHandler: { activate: openRemoteHttpLink, allowNonHttpProtocols: false },
    });
    term.open(termContainer);
    fitTerminal();
    let outputTimer: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    let terminalFrame = 0;
    const updateOutput = () => {
      if (outputTimer) return;
      outputTimer = setTimeout(() => {
        outputTimer = undefined;
        if (!term) return;
        const follow = atBottom();
        setOutput(terminalText(term.buffer.active));
        setMultilinePaste(term.modes.bracketedPasteMode);
        if (follow && reading) {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => {
            if (reading) reading.scrollTop = reading.scrollHeight;
          });
        }
      }, 100);
    };
    const scrollListener = term.onScroll(updateTerminalBottom);
    const parsedListener = term.onWriteParsed(updateOutput);
    // eslint-disable-next-line solid/reactivity -- socket callbacks read the latest layout settings
    const cleanupScrollback = onScrollback(props.agentId, (data, cols, rows) => {
      if (!term) return;
      const followTerminal = terminalBottom();
      // Reset parser and screen so reconnecting cannot duplicate an old frame.
      term.reset();
      term.resize(Math.max(1, cols || 80), Math.max(1, rows || 24));
      fitTerminal();
      term.write(base64ToUint8Array(data), () => {
        updateOutput();
        cancelAnimationFrame(terminalFrame);
        terminalFrame = requestAnimationFrame(() => {
          if (disposed) return;
          if (followTerminal && view() === 'terminal') jumpToLatest();
          else updateTerminalBottom();
        });
      });
    });
    const cleanupOutput = onOutput(props.agentId, (data) =>
      term?.write(base64ToUint8Array(data), updateOutput),
    );
    subscribeAgent(props.agentId);
    const observer = new ResizeObserver(fitTerminal);
    if (outputArea) observer.observe(outputArea);
    // xterm's document-level gesture handler prevents native panning. Own
    // single-finger gestures here so columns/rows pan before scrollback does.
    let touchX = 0;
    let touchY = 0;
    let historyPixels = 0;
    const touchStart = (e: TouchEvent) => {
      e.stopPropagation();
      historyPixels = 0;
      if (e.touches.length === 1) {
        touchX = e.touches[0].clientX;
        touchY = e.touches[0].clientY;
      }
    };
    const touchMove = (e: TouchEvent) => {
      e.stopPropagation();
      // Let the browser handle pinch zoom.
      if (!term || !terminalScroller || e.touches.length !== 1) return;
      e.preventDefault();
      const dx = touchX - e.touches[0].clientX;
      const dy = touchY - e.touches[0].clientY;
      touchX = e.touches[0].clientX;
      touchY = e.touches[0].clientY;
      terminalScroller.scrollLeft += dx;
      const previousTop = terminalScroller.scrollTop;
      terminalScroller.scrollTop = Math.max(
        0,
        Math.min(terminalScroller.scrollHeight - terminalScroller.clientHeight, previousTop + dy),
      );
      if (Math.abs(dy) >= Math.abs(dx)) {
        historyPixels += dy - (terminalScroller.scrollTop - previousTop);
        const lineHeight = fontSize() * 1.2;
        const lines = Math.trunc(historyPixels / lineHeight);
        if (lines) {
          term.scrollLines(lines);
          historyPixels -= lines * lineHeight;
        }
      }
      updateTerminalBottom();
    };
    const touchEnd = (e: TouchEvent) => e.stopPropagation();
    termContainer.addEventListener('touchstart', touchStart, { passive: true });
    termContainer.addEventListener('touchmove', touchMove, { passive: false });
    termContainer.addEventListener('touchend', touchEnd, { passive: true });
    onCleanup(() => {
      disposed = true;
      clearTimeout(outputTimer);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(terminalFrame);
      observer.disconnect();
      termContainer?.removeEventListener('touchstart', touchStart);
      termContainer?.removeEventListener('touchmove', touchMove);
      termContainer?.removeEventListener('touchend', touchEnd);
      unsubscribeAgent(props.agentId);
      cleanupScrollback();
      cleanupOutput();
      scrollListener.dispose();
      parsedListener.dispose();
      term?.dispose();
      term = undefined;
    });
  });

  createEffect(() => {
    const id = taskId();
    if (view() !== 'notes' || !id || untrack(notesDirty)) return;
    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });
    setNotesLoading(true);
    setNotesError('');
    fetchNotes(id)
      .then((text) => {
        if (!cancelled && !untrack(notesDirty)) setNotesText(text);
      })
      .catch((err: unknown) => {
        if (!cancelled) setNotesError(err instanceof Error ? err.message : 'Could not load notes');
      })
      .finally(() => {
        if (!cancelled) setNotesLoading(false);
      });
  });

  async function handleSaveNotes() {
    const id = taskId();
    if (!id || notesSaving()) return;
    if (!canControl()) {
      props.onNeedsPairing();
      return;
    }
    const text = notesText();
    setNotesSaving(true);
    setNotesError('');
    try {
      await saveNotes(id, text);
      if (disposed) return;
      if (notesText() === text) {
        setNotesDirty(false);
        setNotesSaved(true);
        writeLocal(notesKey, '');
        writeLocal(`${notesKey}:dirty`, '');
      }
    } catch (err) {
      if (disposed) return;
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        clearPairedToken();
        props.onNeedsPairing();
      } else setNotesError(err instanceof Error ? err.message : 'Could not save notes');
    } finally {
      if (!disposed) setNotesSaving(false);
    }
  }

  async function handleSend() {
    if (sending() || !inputText().trim()) return;
    if (!canControl()) {
      props.onNeedsPairing();
      return;
    }
    const text = inputText();
    const data = messageForTerminal(text, term?.modes.bracketedPasteMode ?? false);
    if (!data) return;
    setSending(true);
    setSendError('');
    setSent(false);
    try {
      await sendInput(props.agentId, data, true);
      // Clear only the accepted draft, including when the user navigated away.
      if (readLocal(draftKey) === text) writeLocal(draftKey, '');
      if (!disposed) {
        if (inputText() === text) setInputText('');
        setSent(true);
      }
    } catch (err) {
      if (!disposed)
        setSendError(err instanceof Error ? err.message : 'Could not send. Your draft is saved.');
    } finally {
      if (!disposed) setSending(false);
    }
  }

  async function quickKey(data: string) {
    if (!canControl() || sending()) return;
    setSending(true);
    setSendError('');
    setSent(false);
    try {
      await sendInput(props.agentId, data);
    } catch (err) {
      if (!disposed) setSendError(err instanceof Error ? err.message : 'Could not send key');
    } finally {
      if (!disposed) setSending(false);
    }
  }

  function selectView(next: 'output' | 'terminal' | 'notes') {
    setView(next);
    if (next !== 'notes') writeLocal('output-view', next);
    requestAnimationFrame(() => {
      if (!disposed) {
        fitTerminal();
        if (next === 'terminal' || (next === 'output' && atBottom())) jumpToLatest();
      }
    });
  }

  return (
    <div class="mobile-screen">
      <header class="mobile-header mobile-task-header">
        <button
          class="mobile-button quiet"
          onClick={() => props.onBack()}
          aria-label="Back to tasks"
        >
          ←
        </button>
        <div class="heading">
          <h1 title={props.taskName}>{props.taskName}</h1>
          <p class="mobile-task-context">
            {[agent()?.projectName, agent()?.agentName].filter(Boolean).join(' · ')}
          </p>
          <span class="agent-status" style={{ color: display().color }}>
            <span class="status-dot" aria-hidden="true" />
            {display().label}
          </span>
        </div>
      </header>
      <ConnectionBanner />
      <Show when={status() === 'connected' && !canControl()}>
        <div class="mobile-banner info">
          <span>View only</span>
          <button class="mobile-button quiet" onClick={() => props.onNeedsPairing()}>
            Enable replies
          </button>
        </div>
      </Show>
      <nav class="mobile-tabs" aria-label="Task views">
        <For
          each={[
            { id: 'output' as const, label: 'Read' },
            { id: 'terminal' as const, label: 'Terminal' },
            { id: 'notes' as const, label: 'Notes' },
          ]}
        >
          {(tab) => (
            <button aria-pressed={view() === tab.id} onClick={() => selectView(tab.id)}>
              {tab.label}
            </button>
          )}
        </For>
      </nav>
      <div ref={outputArea} class="mobile-output-area">
        <div
          ref={terminalScroller}
          onScroll={updateTerminalBottom}
          class="mobile-terminal-scroll"
          classList={{ 'mobile-terminal-hidden': view() !== 'terminal' }}
          aria-hidden={view() !== 'terminal'}
        >
          <div ref={termContainer} class="mobile-terminal" />
        </div>
        <Show when={view() === 'output'}>
          <div
            ref={reading}
            class="mobile-reading"
            onScroll={(e) =>
              setAtBottom(
                e.currentTarget.scrollHeight -
                  e.currentTarget.scrollTop -
                  e.currentTarget.clientHeight <
                  48,
              )
            }
          >
            <p class="mobile-eyebrow">Agent output</p>
            <Show
              when={output()}
              fallback={
                <div class="mobile-empty" role="status">
                  <h2>
                    {status() !== 'connected'
                      ? 'Reconnecting to your agent'
                      : agent()?.status === 'exited'
                        ? 'Agent session ended'
                        : 'No output yet'}
                  </h2>
                  <p>
                    {status() !== 'connected'
                      ? 'Output will resume when your computer is reachable.'
                      : agent()?.status === 'exited'
                        ? 'Return to your tasks to continue working.'
                        : 'Its output will appear here as it works.'}
                  </p>
                </div>
              }
            >
              <pre>{output()}</pre>
            </Show>
          </div>
        </Show>
        <Show when={view() === 'notes'}>
          <div class="mobile-scroll mobile-notes">
            <Show when={notesError()}>
              <p class="mobile-error" role="alert">
                {notesError()}
              </p>
            </Show>
            <label class="muted" for="task-notes">
              Task notes
            </label>
            <p class="muted">Keep context here. Saving notes won’t send a message to the agent.</p>
            <textarea
              id="task-notes"
              class="mobile-input"
              rows={12}
              value={notesText()}
              disabled={notesLoading()}
              onInput={(e) => {
                setNotesText(e.currentTarget.value);
                setNotesDirty(true);
                setNotesSaved(false);
              }}
              placeholder={notesLoading() ? 'Loading notes…' : 'Keep context for this task…'}
            />
          </div>
        </Show>
        <Show
          when={
            (view() === 'output' && !atBottom()) || (view() === 'terminal' && !terminalBottom())
          }
        >
          <button class="mobile-button mobile-latest" onClick={jumpToLatest}>
            ↓ Latest output
          </button>
        </Show>
      </div>
      <Show
        when={view() === 'notes'}
        fallback={
          <div class="mobile-composer">
            <Show when={inputText().includes('\n') && !multilinePaste()}>
              <p class="muted">This terminal sends line breaks as spaces.</p>
            </Show>
            <Show when={sendError()}>
              <p class="mobile-error" role="alert">
                {sendError()}
              </p>
            </Show>
            <div class="mobile-composer-row">
              <textarea
                ref={(element) => {
                  inputRef = element;
                  queueMicrotask(() => {
                    if (!disposed) resizeComposer();
                  });
                }}
                class="mobile-input"
                rows={1}
                maxlength={4000}
                aria-label="Message agent"
                placeholder={
                  agent()?.attention === 'needs_input' ? 'Reply to agent…' : 'Message agent…'
                }
                value={inputText()}
                onInput={(e) => {
                  setInputText(e.currentTarget.value);
                  setSent(false);
                }}
                disabled={sending()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
              />
              <button
                class="mobile-button primary"
                disabled={!inputText().trim() || sending() || status() !== 'connected'}
                onClick={() => void handleSend()}
              >
                {sending() ? 'Sending…' : canControl() ? 'Send' : 'Authorize'}
              </button>
            </div>
            <div class="mobile-composer-tools">
              <button
                class="mobile-button quiet"
                aria-expanded={showKeys()}
                aria-controls="terminal-keys"
                onClick={() => setShowKeys((v) => !v)}
              >
                Keys {showKeys() ? '⌃' : '⌄'}
              </button>
              <Show when={nextTask()}>
                {(next) => (
                  <button
                    class="mobile-button quiet"
                    aria-label={`Next task needing you: ${next().taskName}`}
                    onClick={() => props.onNextTask(next().taskId)}
                  >
                    Next task →
                  </button>
                )}
              </Show>
            </div>
            <Show when={inputText().length >= 3600}>
              <p class="muted" role="status">
                {4000 - inputText().length} characters remaining
              </p>
            </Show>
            <Show when={sent()}>
              <p class="muted mobile-success" role="status">
                Accepted by terminal
              </p>
            </Show>
            <Show when={showKeys()}>
              <div id="terminal-keys" class="mobile-keys" role="group" aria-label="Terminal keys">
                <For
                  each={[
                    { label: 'Enter', name: 'Enter', data: '\r' },
                    { label: 'Tab', name: 'Tab', data: '\t' },
                    { label: '↑', name: 'Arrow up', data: '\x1b[A' },
                    { label: '↓', name: 'Arrow down', data: '\x1b[B' },
                    { label: 'Esc', name: 'Escape', data: '\x1b' },
                    { label: 'Ctrl+C', name: 'Interrupt agent (Control C)', data: '\x03' },
                  ]}
                >
                  {(key) => (
                    <button
                      class="mobile-button"
                      aria-label={key.name}
                      disabled={!canControl() || sending()}
                      onClick={() => void quickKey(key.data)}
                    >
                      {key.label}
                    </button>
                  )}
                </For>
                <Show when={view() === 'terminal'}>
                  <button
                    class="mobile-button"
                    aria-label="Smaller terminal text"
                    disabled={fontSize() <= 12}
                    onClick={() => {
                      setFontSize((s) => s - 1);
                      writeLocal('terminal-font', String(fontSize()));
                      fitTerminal();
                    }}
                  >
                    A−
                  </button>
                  <button
                    class="mobile-button"
                    aria-label="Larger terminal text"
                    disabled={fontSize() >= 24}
                    onClick={() => {
                      setFontSize((s) => s + 1);
                      writeLocal('terminal-font', String(fontSize()));
                      fitTerminal();
                    }}
                  >
                    A+
                  </button>
                </Show>
              </div>
            </Show>
          </div>
        }
      >
        <footer class="mobile-footer mobile-notes-footer">
          <span class="muted" role="status">
            {notesSaved()
              ? 'Saved to your computer'
              : notesDirty()
                ? 'Draft saved on this phone'
                : ''}
          </span>
          <button
            class="mobile-button primary"
            disabled={notesSaving() || notesLoading() || !notesDirty() || status() !== 'connected'}
            onClick={() => void handleSaveNotes()}
          >
            {notesSaving() ? 'Saving…' : canControl() ? 'Save notes' : 'Authorize'}
          </button>
        </footer>
      </Show>
    </div>
  );
}
