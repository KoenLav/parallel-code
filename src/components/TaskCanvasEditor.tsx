import { createEffect, on, onCleanup, onMount } from 'solid-js';
import { createCanvasEditor } from '../lib/live-markdown';
import type { CanvasEditor, CanvasSelection } from '../lib/live-markdown';
import { minimalBlockWrite, normalizeLineEndings } from '../lib/canvas-blocks';
import type { BlockWrite } from '../lib/canvas-blocks';
import { isMac } from '../lib/platform';

/** Quiet time after the last keystroke before edits go to disk by themselves. */
export const CANVAS_AUTOSAVE_IDLE_MS = 1500;

export interface CanvasWrite extends BlockWrite {
  /** The file content the write assumes; the backend refuses anything else. */
  expectedContent: string;
}

export interface CanvasEditorApi {
  /** Flushes unsaved edits; resolves once they are on disk or have failed. */
  save: () => Promise<boolean>;
  /** Replaces the editor state even when it matches an in-flight save. */
  reload: (source: string) => void;
}

export interface TaskCanvasEditorProps {
  documentPath: string;
  /** What the editor shows. A new value replaces the document wholesale, so
   *  the parent only changes it when there are no unsaved edits. */
  source: string;
  onDirty: (dirty: boolean) => void;
  /** Applies the write to disk; resolves true once the file holds it. */
  onSave: (write: CanvasWrite) => Promise<boolean>;
  onSelect: (selection: CanvasSelection | null) => void;
  ref: (api: CanvasEditorApi) => void;
}

/** The live Markdown surface of the canvas, guarded against stale disk writes. */
export function TaskCanvasEditor(props: TaskCanvasEditorProps) {
  let host: HTMLDivElement | undefined;
  let editor: CanvasEditor | undefined;
  // The source the editor represents on disk.
  let loaded = '';
  let pendingSource: string | undefined;
  let dirty = false;
  let inFlight: Promise<boolean> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;

  function setDirty(next: boolean): void {
    if (next === dirty) return;
    dirty = next;
    props.onDirty(next);
  }

  function rebase(source: string): void {
    if (!editor) return;
    loaded = source;
    setDirty(false);
  }

  function scheduleSave(): void {
    clearTimeout(idle);
    idle = setTimeout(() => void save(), CANVAS_AUTOSAVE_IDLE_MS);
  }

  function onChange(matchesSaved: boolean): void {
    setDirty(!matchesSaved);
    if (dirty) scheduleSave();
    else clearTimeout(idle);
  }

  async function save(): Promise<boolean> {
    clearTimeout(idle);
    if (inFlight) {
      if (!(await inFlight)) return false;
      return dirty ? save() : true;
    }
    const activeEditor = editor;
    if (!activeEditor) return false;
    if (!dirty) return true;
    const whole = activeEditor.markdown();
    if (whole === normalizeLineEndings(loaded)) {
      activeEditor.markSaved(whole);
      setDirty(false);
      return true;
    }
    const source = loaded;
    const write = minimalBlockWrite(source, whole);
    const saved =
      source.slice(0, write.startOffset) + write.replacement + source.slice(write.endOffset);
    pendingSource = saved;
    const operation = (async (): Promise<boolean> => {
      try {
        const ok = await props.onSave({ ...write, expectedContent: source });
        if (!ok) return false;
        loaded = saved;
        setDirty(!activeEditor.markSaved(whole));
        if (dirty) scheduleSave();
        return true;
      } finally {
        pendingSource = undefined;
      }
    })();
    inFlight = operation;
    try {
      return await operation;
    } finally {
      if (inFlight === operation) inFlight = undefined;
    }
  }

  function reload(source: string): void {
    if (!editor) return;
    editor.load(source);
    rebase(source);
    props.onSelect(null);
  }

  onMount(() => {
    if (!host) return;
    const root = host;
    const initial = props.source;
    editor = createCanvasEditor({
      root,
      defaultValue: initial,
      placeholder: 'Write Markdown…',
      ariaLabel: `Editor for ${props.documentPath}`,
      onChange,
      onSelection: (selection) => props.onSelect(selection),
    });
    rebase(initial);
    props.ref({ save, reload });
    onCleanup(() => {
      clearTimeout(idle);
      editor?.destroy();
      editor = undefined;
    });
  });

  // Disk content the parent decided should win replaces the document.
  createEffect(
    on(
      () => props.source,
      (source) => {
        if (!editor || source === loaded || source === pendingSource) return;
        reload(source);
      },
      { defer: true },
    ),
  );

  return (
    <div
      ref={host}
      class="task-canvas-editor"
      data-testid="canvas-editor"
      style={{ flex: '1', 'min-height': '0', overflow: 'auto' }}
      onKeyDown={(e) => {
        if (e.key === 's' && (isMac ? e.metaKey : e.ctrlKey)) {
          e.preventDefault();
          void save();
        }
      }}
    />
  );
}
