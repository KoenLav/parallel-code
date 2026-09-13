import { Show, createEffect, createSignal, onCleanup, untrack } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import { TaskCanvasEditor } from '../components/TaskCanvasEditor';
import type { CanvasDraft, CanvasEditorApi, CanvasWrite } from '../components/TaskCanvasEditor';
import { applyBlockWrite, normalizeLineEndings } from '../lib/canvas-blocks';
import { invoke } from '../lib/ipc';
import { errMessage } from '../lib/log';
import {
  pendingMarkdownWrite,
  readMarkdownDraft,
  registerMarkdownEditor,
  trackMarkdownWrite,
  writeMarkdownDraft,
} from './markdown-editing';

interface MarkdownEditorProps {
  projectRoot: string;
  documentPath: string;
  source: string;
  missing: boolean;
  onSaved: () => void | Promise<void>;
}

export function MarkdownEditor(props: MarkdownEditorProps) {
  const pending = untrack(() => pendingMarkdownWrite(props.projectRoot, props.documentPath));
  const refreshSnapshot = untrack(() => props.onSaved);
  const [ready, setReady] = createSignal(!pending);
  const [error, setError] = createSignal('');
  let mounted = true;
  let saveEditor: (() => Promise<boolean>) | undefined;
  const waiting = pending
    ?.then(async () => {
      if (!mounted) return;
      // The snapshot obtained when reopening may predate the outstanding write.
      await refreshSnapshot();
      if (mounted) setReady(true);
    })
    .catch((err: unknown) => {
      if (mounted) setError(errMessage(err));
    });
  const save = () => (mounted && saveEditor ? saveEditor() : Promise.resolve(false));
  onCleanup(registerMarkdownEditor(() => (waiting ? waiting.then(save) : save())));
  onCleanup(() => {
    mounted = false;
  });

  return (
    <Show
      when={ready()}
      fallback={
        <div class="docws-editor-status" role={error() ? 'alert' : 'status'}>
          {error() || 'Finishing the previous save…'}
        </div>
      }
    >
      <MarkdownEditorSession
        {...props}
        onReady={(save) => {
          saveEditor = save;
        }}
      />
    </Show>
  );
}

function MarkdownEditorSession(
  props: MarkdownEditorProps & { onReady: (save: () => Promise<boolean>) => void },
) {
  const root = untrack(() => props.projectRoot);
  const path = untrack(() => props.documentPath);
  const stored = readMarkdownDraft(root, path);
  const initialDraft =
    stored && stored.markdown !== normalizeLineEndings(untrack(() => props.source))
      ? stored
      : undefined;
  const [base, setBase] = createSignal(initialDraft?.source ?? untrack(() => props.source));
  const [dirty, setDirty] = createSignal(!!initialDraft);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal('');
  const [backupError, setBackupError] = createSignal('');
  let editor: CanvasEditorApi | undefined;
  let mounted = true;
  let latestDraft: CanvasDraft | null = initialDraft ?? null;
  const changedOnDisk = () => dirty() && (props.missing || props.source !== base());

  function persistDraft(draft: CanvasDraft | null) {
    try {
      writeMarkdownDraft(root, path, draft);
      if (mounted) setBackupError('');
    } catch {
      if (mounted)
        setBackupError('Could not back up your draft. Save before closing or switching documents.');
    }
  }

  function backup(draft: CanvasDraft | null) {
    if (!mounted) return;
    latestDraft = draft;
    persistDraft(draft);
  }

  createEffect(() => {
    const source = props.source;
    // A watcher update deferred while saving must be applied once the draft is clean.
    if (!dirty() && !saving()) setBase(source);
  });

  async function save(write: CanvasWrite): Promise<boolean> {
    setSaving(true);
    setError('');
    let saved: string | undefined;
    try {
      await invoke(IPC.WriteDocumentBlock, { projectRoot: root, documentPath: path, ...write });
      saved = applyBlockWrite(write.expectedContent, write);
      if (mounted) {
        setBase(saved);
        await props.onSaved();
      }
      return true;
    } catch (err) {
      if (mounted) setError(errMessage(err));
      return false;
    } finally {
      if (!mounted && saved !== undefined) {
        // Preserve the last buffer, but compare its next save against the write that just finished.
        persistDraft(
          latestDraft && latestDraft.markdown !== normalizeLineEndings(saved)
            ? { source: saved, markdown: latestDraft.markdown }
            : null,
        );
      }
      if (mounted) setSaving(false);
    }
  }

  onCleanup(() => {
    mounted = false;
  });
  if (stored && !initialDraft) backup(null);

  return (
    <div class="docws-markdown-editor">
      <div class="docws-editor-status">
        <span role="status">{saving() ? 'Saving…' : dirty() ? 'Unsaved edits' : 'Saved'}</span>
        <button
          type="button"
          class="docws-btn docws-btn-sm"
          disabled={saving() || !dirty()}
          onClick={() => void editor?.save()}
          title="Save now (Cmd/Ctrl+S); autosaves when you pause"
        >
          Save
        </button>
      </div>
      <Show when={error() || backupError()}>
        <div class="docws-banner docws-banner-error" role="alert">
          {error() || backupError()}
        </div>
      </Show>
      <Show when={changedOnDisk()}>
        <div class="docws-older-banner" role="alert">
          The file changed on disk. Your draft is kept; copy it before reloading.
          <button
            type="button"
            class="docws-btn docws-btn-sm"
            disabled={saving() || props.missing}
            onClick={() => {
              editor?.reload(props.source);
              setBase(props.source);
              setError('');
            }}
          >
            Reload and discard my draft
          </button>
        </div>
      </Show>
      <TaskCanvasEditor
        documentPath={path}
        source={base()}
        initialDraft={initialDraft}
        onDirty={setDirty}
        onDraft={backup}
        onSave={(write) => trackMarkdownWrite(root, path, save(write))}
        onSelect={() => {}}
        ref={(api) => {
          editor = api;
          props.onReady(api.save);
        }}
      />
    </div>
  );
}
