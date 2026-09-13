import { For, Show, createEffect } from 'solid-js';
import type { ChangeTourController } from '../lib/create-change-tour';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';

/** Closing the reader preserves the task's generated tour. */
export function ChangeTour(props: {
  tour: ChangeTourController;
  onNavigate: (filePath: string, line: number) => void;
  onFinish: () => void;
}) {
  const stop = () => props.tour.stops()[props.tour.step()];
  const isLastStep = () => props.tour.step() === props.tour.stops().length - 1;
  let contentRef: HTMLDivElement | undefined;
  createEffect(() => {
    const location = stop()?.locations[0];
    if (contentRef) contentRef.scrollTop = 0;
    if (location) props.onNavigate(location.filePath, location.line);
  });
  return (
    <Show when={stop()}>
      {(current) => (
        <section
          aria-label="Guided change tour"
          style={{
            display: 'flex',
            'flex-direction': 'column',
            margin: '12px',
            border: `1px solid ${theme.accent}`,
            'border-radius': '12px',
            'box-shadow': `0 4px 20px color-mix(in srgb, ${theme.accent} 18%, transparent)`,
            background: `color-mix(in srgb, ${theme.accent} 8%, ${theme.bgElevated})`,
            'max-height': '70%',
            'min-height': '0',
            'flex-shrink': '0',
            overflow: 'hidden',
            color: theme.fg,
            'font-size': sf(15),
          }}
        >
          <div
            style={{
              display: 'flex',
              'justify-content': 'space-between',
              gap: '12px',
              padding: '14px 16px',
              'flex-shrink': '0',
              'font-size': sf(12),
              'font-weight': '600',
              background: theme.accent,
              color: theme.accentText,
              'margin-bottom': '18px',
            }}
          >
            <span>GUIDED TOUR</span>
            <span>
              Stop {props.tour.step() + 1} of {props.tour.stops().length}
            </span>
          </div>
          <div
            ref={contentRef}
            style={{
              padding: '0 16px 14px',
              overflow: 'auto',
              'min-height': '0',
              'overflow-wrap': 'anywhere',
            }}
          >
            <h2 style={{ margin: '0 0 16px', 'font-size': sf(21), 'line-height': '1.35' }}>
              {current().title}
            </h2>
            <p style={{ margin: '0 0 16px', 'white-space': 'pre-wrap', 'line-height': '1.7' }}>
              {current().explanation}
            </p>
            <For each={current().locations}>
              {(location) => (
                <button
                  class="review-control"
                  style={{
                    display: 'block',
                    'max-width': '100%',
                    'overflow-wrap': 'anywhere',
                    'margin-bottom': '6px',
                    padding: '6px 8px',
                    'font-size': sf(13),
                    'text-align': 'left',
                  }}
                  onClick={() => props.onNavigate(location.filePath, location.line)}
                >
                  {location.filePath}:{location.line}
                </button>
              )}
            </For>
            <Show when={props.tour.omittedFileCount() > 0}>
              <p style={{ color: theme.fgMuted, 'font-size': sf(12), 'line-height': '1.5' }}>
                {props.tour.omittedFileCount()} files are outside this tour. Use “Show all changes”
                to review them.
              </p>
            </Show>
            <p
              style={{
                margin: '12px 0 0',
                color: theme.fgMuted,
                'font-size': sf(12),
                'line-height': '1.5',
              }}
            >
              Showing changes captured when this tour was generated.
            </p>
          </div>
          <div
            style={{
              display: 'flex',
              gap: '8px',
              padding: '12px 16px',
              'border-top': `1px solid ${theme.border}`,
              'flex-shrink': '0',
            }}
          >
            <button
              class="review-control"
              style={{ flex: '1', padding: '8px 12px', 'font-size': sf(14) }}
              disabled={props.tour.step() === 0}
              onClick={() => props.tour.navigate(props.tour.step() - 1)}
            >
              Previous
            </button>
            <button
              class="review-control"
              style={{
                flex: '1',
                padding: '8px 12px',
                'font-size': sf(14),
                'font-weight': '600',
                background: theme.accent,
                color: theme.accentText,
              }}
              onClick={() => {
                if (isLastStep()) props.onFinish();
                else props.tour.navigate(props.tour.step() + 1);
              }}
            >
              {isLastStep() ? 'Finish tour' : 'Next'}
            </button>
          </div>
        </section>
      )}
    </Show>
  );
}
