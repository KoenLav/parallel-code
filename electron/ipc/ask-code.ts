import { spawn, type ChildProcess } from 'child_process';
import type { BrowserWindow } from 'electron';
import { validateCommand, ENV_BLOCK_LIST } from './pty.js';
import { loadEnvFile } from './env-file.js';
import { ASK_CODE_MODELS } from '../shared/ask-code-models.js';
import { CHANGE_TOUR_TIMEOUT_MS, CHANGE_TOUR_PROMPT_LIMIT } from '../shared/change-tour-limits.js';
import {
  askAboutCodeMinimax,
  cancelAskAboutCodeMinimax,
  isMinimaxRequestActive,
} from './ask-code-minimax.js';
import {
  AskCodeSession,
  ASK_CODE_MAX_CONCURRENT,
  ASK_CODE_TIMEOUT_MS,
  RequestRegistry,
  assertCanStart,
  assertPromptWithinLimit,
} from './request-registry.js';

export type AskCodeProvider = 'claude' | 'minimax';

interface AskCodeRequest {
  requestId: string;
  channelId: string;
  prompt: string;
  cwd: string;
  provider?: AskCodeProvider;
  purpose?: 'tour';
  /** Env file configured for the Claude Code agent, if any. */
  envFile?: string;
}

const activeRequests = new RequestRegistry<ChildProcess>({
  maxConcurrent: ASK_CODE_MAX_CONCURRENT,
  timeoutMs: ASK_CODE_TIMEOUT_MS,
});

export function askAboutCode(win: BrowserWindow, args: AskCodeRequest): void {
  const { requestId, channelId, prompt, cwd, provider, envFile } = args;

  // Route to MiniMax backend when configured
  if (provider === 'minimax') {
    activeRequests.cancel(requestId);
    askAboutCodeMinimax(win, { requestId, channelId, prompt, purpose: args.purpose });
    return;
  }

  const isTour = args.purpose === 'tour';
  assertPromptWithinLimit(prompt, isTour ? CHANGE_TOUR_PROMPT_LIMIT : undefined);
  assertCanStart(activeRequests, requestId);

  // Cancel any existing request with the same ID
  cancelAskAboutCode(requestId);

  validateCommand('claude');

  const filteredEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) filteredEnv[k] = v;
  }
  // Ask Code runs the same `claude` CLI as an agent terminal, so it needs the
  // same credentials — otherwise configuring an env file fixes the terminals
  // and leaves this silently broken.
  if (envFile?.trim()) {
    for (const [k, v] of Object.entries(loadEnvFile(envFile))) {
      if (!ENV_BLOCK_LIST.has(k)) filteredEnv[k] = v;
    }
  }
  // Clear env vars that prevent nested agent sessions
  delete filteredEnv.CLAUDECODE;
  delete filteredEnv.CLAUDE_CODE_SESSION;
  delete filteredEnv.CLAUDE_CODE_ENTRYPOINT;

  const proc = spawn(
    'claude',
    [
      '-p',
      ...(isTour ? [] : [prompt]),
      '--output-format',
      'text',
      '--model',
      ASK_CODE_MODELS.claude,
      // Empty string disables all tool usage for quick Q&A responses
      '--tools',
      '',
      '--no-session-persistence',
      '--append-system-prompt',
      isTour
        ? 'Return exactly one JSON object matching the requested tour schema. No markdown, commentary, or additional JSON objects.'
        : 'Answer concisely about the selected code. Use markdown.',
    ],
    {
      cwd,
      env: filteredEnv,
      stdio: [isTour ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    },
  );

  const send = (msg: unknown) => {
    if (!win.isDestroyed()) {
      win.webContents.send(`channel:${channelId}`, msg);
    }
  };

  const session = AskCodeSession.start(
    activeRequests,
    requestId,
    proc,
    send,
    (request) => request.kill('SIGTERM'),
    args.purpose === 'tour' ? CHANGE_TOUR_TIMEOUT_MS : undefined,
  );

  proc.stdout?.on('data', (chunk: Buffer) => {
    send({ type: 'chunk', text: chunk.toString('utf8') });
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    send({ type: 'error', text: chunk.toString('utf8') });
  });

  proc.on('close', (code) => {
    session.cleanup();
    if (session.complete()) {
      send({ type: 'done', exitCode: code });
    }
  });

  proc.on('error', (err) => {
    session.cleanup();
    if (session.complete()) {
      send({ type: 'error', text: err.message });
      send({ type: 'done', exitCode: 1 });
    }
  });

  if (isTour) {
    // Large diffs exceed OS argument-size limits; Claude supports piped input.
    proc.stdin?.on('error', (err: Error) => {
      if (!session.complete()) return;
      session.cleanup();
      send({ type: 'error', text: `Could not send tour prompt: ${err.message}` });
      send({ type: 'done', exitCode: 1 });
      proc.kill('SIGTERM');
    });
    proc.stdin?.end(prompt);
  }
}

export function cancelAskAboutCode(requestId: string): void {
  if (isMinimaxRequestActive(requestId)) {
    cancelAskAboutCodeMinimax(requestId);
  }

  activeRequests.cancel(requestId);
}
