import { createSignal, createEffect, onMount, onCleanup, Show, Switch, Match } from 'solid-js';
import { initAuth, getPairedToken } from './auth';
import { connect, reconnect, agents, status, needsConnection, canControl } from './ws';
import { readLocal, writeLocal } from './storage';
import { AgentList } from './AgentList';
import { AgentDetail } from './AgentDetail';
import { ConnectScreen } from './ConnectScreen';
import { PairScreen } from './PairScreen';
import { NewTaskScreen } from './NewTaskScreen';
import { ConnectionBanner } from './ConnectionBanner';

export function App() {
  const [authed, setAuthed] = createSignal(false);
  const [route, setRoute] = createSignal(window.location.hash.slice(1));
  const [pairing, setPairing] = createSignal(false);
  const [ready, setReady] = createSignal(false);
  const [createdTaskId, setCreatedTaskId] = createSignal('');
  const [createdName, setCreatedName] = createSignal('');
  const taskId = () => new URLSearchParams(route()).get('task');
  const agent = () => agents().find((a) => a.taskId === taskId());
  const waitingForCreated = () => taskId() === createdTaskId();
  createEffect(() => {
    if (agent()?.taskId === createdTaskId()) setCreatedTaskId('');
  });

  function navigate(next: string) {
    window.history.pushState(
      {},
      '',
      `${window.location.pathname}${window.location.search}${next ? `#${next}` : ''}`,
    );
    setRoute(next);
  }
  function openTask(id: string) {
    navigate(new URLSearchParams({ task: id }).toString());
  }
  function onConnected() {
    setAuthed(true);
    connect();
    if (!getPairedToken() && !readLocal('view-only')) setPairing(true);
  }
  function pairForTask() {
    setReady(false);
    setPairing(true);
  }
  function startNewTask() {
    navigate('new');
    if (!getPairedToken()) pairForTask();
  }

  onMount(() => {
    if (initAuth()) onConnected();
    const onHashChange = () => {
      setRoute(window.location.hash.slice(1));
      setPairing(false);
      setReady(false);
    };
    const onResume = () => {
      if (
        document.visibilityState === 'visible' &&
        status() === 'disconnected' &&
        !needsConnection()
      )
        reconnect();
    };
    // Keep the composer above phone keyboards, including Safari's visual viewport.
    const fitViewport = () => {
      const viewport = window.visualViewport;
      if (!viewport || viewport.scale !== 1) return;
      document.getElementById('root')?.style.setProperty('height', `${viewport.height}px`);
    };
    fitViewport();
    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('popstate', onHashChange);
    window.addEventListener('online', onResume);
    document.addEventListener('visibilitychange', onResume);
    window.visualViewport?.addEventListener('resize', fitViewport);
    onCleanup(() => {
      window.removeEventListener('hashchange', onHashChange);
      window.removeEventListener('popstate', onHashChange);
      window.removeEventListener('online', onResume);
      document.removeEventListener('visibilitychange', onResume);
      window.visualViewport?.removeEventListener('resize', fitViewport);
      document.getElementById('root')?.style.removeProperty('height');
    });
  });

  return (
    <Show
      when={authed() && !needsConnection()}
      fallback={<ConnectScreen onConnected={onConnected} />}
    >
      <Switch>
        <Match when={pairing()}>
          <PairScreen
            onPaired={() => {
              writeLocal('view-only', '');
              reconnect();
              setPairing(false);
              setReady(true);
            }}
            onCancel={() => {
              writeLocal('view-only', 'true');
              setPairing(false);
              if (route() === 'new') navigate('');
            }}
          />
        </Match>
        <Match when={ready()}>
          <main class="mobile-screen mobile-setup">
            <div class="mobile-setup-inner">
              <ol class="mobile-steps" aria-label="Phone setup">
                <li>1. Connect</li>
                <li>2. Authorize</li>
                <li class="current" aria-current="step">
                  3. Ready
                </li>
              </ol>
              <div>
                <h1>You’re ready to go</h1>
                <p>
                  Reply to agents and start tasks from this phone. Keep Parallel Code open on your
                  computer.
                </p>
              </div>
              <ConnectionBanner />
              <button
                class="mobile-button primary"
                disabled={status() !== 'connected'}
                onClick={() => (canControl() ? setReady(false) : pairForTask())}
              >
                {canControl()
                  ? 'Continue to your work'
                  : status() === 'connected'
                    ? 'Enable replies again'
                    : 'Connecting…'}
              </button>
            </div>
          </main>
        </Match>
        <Match when={route() === 'new'}>
          <NewTaskScreen
            onCreated={(id, name) => {
              setCreatedTaskId(id);
              setCreatedName(name);
              openTask(id);
            }}
            onCancel={() => navigate('')}
            onNeedsPairing={pairForTask}
          />
        </Match>
        <Match when={taskId()}>
          <Show
            when={agent()?.agentId}
            keyed
            fallback={
              <div class="mobile-screen">
                <header class="mobile-header">
                  <button class="mobile-button quiet" onClick={() => navigate('')}>
                    Back
                  </button>
                  <h1>{waitingForCreated() ? createdName() : 'Task'}</h1>
                </header>
                <ConnectionBanner />
                <div class="mobile-empty" role="status">
                  <h2>{waitingForCreated() ? 'Waiting for the agent' : 'Task is not running'}</h2>
                  <p>
                    {waitingForCreated()
                      ? 'Your task was created. It will open here when its agent starts. If it does not appear, check its status on your computer.'
                      : 'It may have finished or been closed on your computer.'}
                  </p>
                  <button class="mobile-button" onClick={() => navigate('')}>
                    View all tasks
                  </button>
                </div>
              </div>
            }
          >
            {(agentId) => (
              <AgentDetail
                agentId={agentId}
                taskName={agent()?.taskName ?? ''}
                onBack={() => navigate('')}
                onNeedsPairing={pairForTask}
                onNextTask={openTask}
              />
            )}
          </Show>
        </Match>
        <Match when={true}>
          <AgentList onSelect={openTask} onNewTask={startNewTask} onPair={pairForTask} />
        </Match>
      </Switch>
    </Show>
  );
}
