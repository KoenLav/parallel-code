import { createMemo, createEffect, onCleanup, Show } from 'solid-js';
import {
  store,
  getMergedTasksTodayCount,
  getMergedLineTotals,
  toggleHelpDialog,
  toggleArena,
  hasAnyCoordinatorTask,
  startMCPStatusPolling,
  stopMCPStatusPolling,
} from '../store/store';
import { theme } from '../lib/theme';
import { alt, mod } from '../lib/platform';

/** Compact utilities and optional activity totals, shared by every theme. */
export function SidebarFooter(props: { onConnectPhone: () => void }) {
  const mergedTasksToday = createMemo(() => getMergedTasksTodayCount());
  const mergedLines = createMemo(() => getMergedLineTotals());
  const hasCoordinator = createMemo(() => hasAnyCoordinatorTask());
  const phoneConnected = () =>
    store.remoteAccess.enabled && store.remoteAccess.connectedClients > 0;

  createEffect(() => {
    if (hasCoordinator()) {
      startMCPStatusPolling();
    } else {
      stopMCPStatusPolling();
    }
  });

  onCleanup(() => stopMCPStatusPolling());

  const mcpOk = () => store.mcpStatus.running;

  return (
    <div class="sidebar-footer">
      <Show when={hasCoordinator()}>
        <div class="sidebar-footer-connection">
          <div
            style={{
              width: '8px',
              height: '8px',
              'border-radius': '50%',
              background: mcpOk() ? theme.success : theme.error,
              'flex-shrink': '0',
            }}
          />
          <span>MCP {mcpOk() ? 'Connected' : 'Disconnected'}</span>
        </div>
      </Show>

      <div class="sidebar-footer-tools">
        <h2 class="sidebar-footer-heading">Workspace</h2>
        <div class="sidebar-footer-actions">
          <button
            onClick={() => props.onConnectPhone()}
            title={
              phoneConnected()
                ? 'Phone connected: manage remote access'
                : 'Connect a phone for remote access'
            }
            type="button"
            class="sidebar-footer-action"
            aria-label={
              phoneConnected() ? 'Phone connected: manage remote access' : 'Connect phone'
            }
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
              <line x1="12" y1="18" x2="12.01" y2="18" />
            </svg>
            <span>Phone access</span>
            <Show when={phoneConnected()}>
              <span class="sidebar-footer-connected-dot" aria-hidden="true" />
            </Show>
          </button>
          <button
            onClick={() => toggleArena(true)}
            title="Arena: run two agents on the same prompt and compare"
            type="button"
            class="sidebar-footer-action"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M3 3L13 13M9 12L12 9" />
              <path d="M13 3L3 13M4 9L7 12" />
            </svg>
            Arena
          </button>

          <Show when={store.showSidebarTips}>
            <button
              type="button"
              class="sidebar-footer-action sidebar-footer-shortcuts"
              onClick={() => toggleHelpDialog(true)}
              title={`Keyboard shortcuts (${mod}+/). Switch panels with ${alt}+Arrows.`}
            >
              <span class="sidebar-footer-action-label">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.25"
                  aria-hidden="true"
                >
                  <rect x="1.5" y="3.5" width="13" height="9" rx="1" />
                  <path d="M4 6h1m2 0h1m2 0h2M4 8.5h1m2 0h1m2 0h2M5 10.5h6" />
                </svg>
                Shortcuts
              </span>
              <kbd>{mod} /</kbd>
            </button>
          </Show>
        </div>
      </div>

      <Show when={store.showSidebarProgress}>
        <div class="sidebar-footer-progress">
          <div class="sidebar-footer-stat" title="Tasks merged today">
            <span>Merged today</span>
            <strong>{mergedTasksToday()}</strong>
          </div>
          <div class="sidebar-footer-lines" title="Lines added / removed across all merged tasks">
            <span>Merged lines</span>
            <span class="sidebar-footer-line-totals">
              <span style={{ color: theme.success }}>+{mergedLines().added.toLocaleString()}</span>
              <span style={{ color: theme.error }}>−{mergedLines().removed.toLocaleString()}</span>
            </span>
          </div>
        </div>
      </Show>
    </div>
  );
}
