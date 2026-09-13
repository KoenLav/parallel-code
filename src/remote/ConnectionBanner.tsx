import { Show } from 'solid-js';
import { status, reconnect } from './ws';

export function ConnectionBanner() {
  return (
    <Show when={status() !== 'connected'}>
      <div class="mobile-banner" role="status">
        <span>
          {status() === 'connecting'
            ? 'Connecting to your computer…'
            : 'Connection lost. Showing the last received state.'}
        </span>
        <button class="mobile-button quiet" onClick={reconnect}>
          Retry
        </button>
      </div>
    </Show>
  );
}
