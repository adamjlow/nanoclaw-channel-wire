/**
 * Wire channel adapter — joins Wire conversations as a Wire app.
 *
 * Direct adapter around @wireapp/wire-apps-js-sdk (no Chat SDK adapter exists
 * for Wire). The SDK never loads in the NanoClaw host process: this module
 * supervises a forked worker (wire-worker.ts) that owns the SDK, its
 * WebSocket, MLS/CoreCrypto state and SQLite store, and talks to it over IPC
 * (wire-protocol.ts). See docs/design.md in nanoclaw-channel-wire for the reasoning.
 *
 * Identity mapping:
 *   platformId  conversation QualifiedId → `<uuid>@<domain>` (lowercased)
 *   user id     sender QualifiedId       → `wire:<uuid>@<domain>`
 *   threads     none (supportsThreads: false)
 *
 * State: <store>/wire/ holds the SDK's storage/apps.db and
 * storage/cryptography, plus worker.lock. With WIRE_CRYPTO_KEY it IS the app's
 * device identity and its current (rotated) token — back up together, never
 * mount into agent containers, never delete as routine recovery.
 *
 * Credentials (.env): WIRE_API_HOST, WIRE_API_TOKEN (first start only; the
 * backend rotates it into apps.db), WIRE_CRYPTO_KEY (64 hex chars).
 * Optional: WIRE_MAX_ATTACHMENT_MB (default 25).
 *
 * Addressed-only: the worker forwards a message only if it is for this app (a
 * 1:1 conversation, an @mention, a reply to the app's message, or a click on
 * its buttons) and discards the rest before it leaves the worker. This module
 * re-checks that (defence in depth), so group chatter can never reach the
 * router, whatever a wiring's engage mode or ignored-message policy says.
 */
import { fork, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

import { STORE_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type {
  ChannelAdapter,
  ChannelDefaults,
  ChannelSetup,
  InboundMessage,
  OutboundMessage,
  ResolvedConversation,
} from './adapter.js';
import { normalizeOptions, type NormalizedOption, type RawOption } from './ask-question.js';
import { registerChannelAdapter } from './channel-registry.js';
import {
  EXIT_TRANSIENT,
  PERMANENT_FAILURES,
  describeError,
  isValidCryptoKeyHex,
  parseQualifiedKey,
  qualifiedKey,
  redact,
  type AttachmentPolicy,
  type HostToWorker,
  type InboundAsset,
  type InboundButton,
  type InboundText,
  type MentionSpan,
  type QualifiedIdLike,
  type WorkerEvent,
  type WorkerFailureCode,
  type WorkerOp,
  type WorkerOpResults,
  type WorkerToHost,
} from './wire-protocol.js';

const CHANNEL = 'wire';

/** Wire clients reject longer text (MAXIMUM_MESSAGE_LENGTH). */
export const WIRE_TEXT_LIMIT = 8000;
const READY_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 30_000;
const ASSET_CALL_TIMEOUT_MS = 120_000;
const SHUTDOWN_GRACE_MS = 10_000;
const KILL_GRACE_MS = 5_000;
const RESPAWN_MIN_MS = 5_000;
const RESPAWN_MAX_MS = 5 * 60_000;
/** A worker that stayed up this long resets the respawn backoff. */
const STABLE_UPTIME_MS = 5 * 60_000;
const DEDUPE_MAX = 2000;
const MESSAGE_CACHE_MAX = 500;
const PENDING_QUESTIONS_MAX = 64;
const QUOTE_MAX_CHARS = 280;
const DEFAULT_MAX_ATTACHMENT_MB = 25;

/**
 * Every admitted message leaves Wire's end-to-end encryption for the agent's
 * model provider, so defaults are conservative: unknown senders are dropped,
 * and groups engage only on an @mention of the app. Operators loosen per
 * group with ncl / /manage-channels.
 */
export const WIRE_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'strict' },
  mentions: 'platform',
};

// ── Configuration ──────────────────────────────────────────────────────────

export interface WireConfig {
  apiHost: string;
  apiToken: string;
  cryptoKeyHex: string;
  attachments: AttachmentPolicy;
  assistantName: string;
}

const ENV_KEYS = ['WIRE_API_HOST', 'WIRE_API_TOKEN', 'WIRE_CRYPTO_KEY', 'WIRE_MAX_ATTACHMENT_MB', 'ASSISTANT_NAME'];

/** Validate .env values; returns an operator-facing problem string when invalid. */
export function parseWireConfig(env: Record<string, string | undefined>): WireConfig | string {
  const missing = ['WIRE_API_HOST', 'WIRE_API_TOKEN', 'WIRE_CRYPTO_KEY'].filter((k) => !env[k]);
  if (missing.length) return `missing ${missing.join(', ')} in .env`;
  let host: URL;
  try {
    host = new URL(env.WIRE_API_HOST!);
  } catch {
    return 'WIRE_API_HOST is not a valid URL';
  }
  if (host.protocol !== 'https:') return 'WIRE_API_HOST must be an https:// URL';
  if (!isValidCryptoKeyHex(env.WIRE_CRYPTO_KEY!)) return 'WIRE_CRYPTO_KEY must be exactly 64 hex characters';
  const mb = env.WIRE_MAX_ATTACHMENT_MB ? Number(env.WIRE_MAX_ATTACHMENT_MB) : DEFAULT_MAX_ATTACHMENT_MB;
  if (!Number.isFinite(mb) || mb <= 0 || mb > 1024)
    return 'WIRE_MAX_ATTACHMENT_MB must be a number of megabytes (1-1024)';
  return {
    apiHost: host.origin,
    apiToken: env.WIRE_API_TOKEN!.trim(),
    cryptoKeyHex: env.WIRE_CRYPTO_KEY!.trim(),
    attachments: { maxBytes: Math.floor(mb * 1024 * 1024) },
    assistantName: env.ASSISTANT_NAME || 'Andy',
  };
}

/**
 * The SDK's native CoreCrypto library ships only for Linux x86_64 (glibc
 * 2.38+) and macOS arm64. Returns a problem string on any other host.
 */
export function checkPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  /** null: no glibc (musl) or not Linux. */
  glibc: string | null = glibcVersion(),
): string | null {
  if (platform === 'darwin') return arch === 'arm64' ? null : 'Wire requires Apple Silicon (arm64) on macOS';
  if (platform !== 'linux') return `Wire is not supported on ${platform}`;
  if (arch !== 'x64') return `Wire requires x86_64 on Linux (found ${arch})`;
  if (!glibc) return 'Wire requires glibc 2.38 or newer (musl/Alpine is not supported)';
  const [major, minor] = glibc.split('.').map(Number);
  if (major < 2 || (major === 2 && minor < 38)) {
    return `Wire requires glibc 2.38 or newer (found ${glibc}; e.g. Debian 13 or Ubuntu 24.04+)`;
  }
  return null;
}

function glibcVersion(): string | null {
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return report?.header?.glibcVersionRuntime ?? null;
}

// ── Pure helpers (exported for tests) ──────────────────────────────────────

/** Split on paragraph, then line, then space boundaries; hard-cut as a last resort. */
export function splitText(text: string, limit = WIRE_TEXT_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf('\n\n');
    if (cut < limit / 2) cut = window.lastIndexOf('\n');
    if (cut < limit / 2) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.trim()) chunks.push(rest);
  return chunks;
}

/** Replace the app's @mention spans with `@<assistant name>` so the agent sees its own name. */
export function rewriteAppMentions(text: string, spans: MentionSpan[], assistantName: string): string {
  let out = text;
  for (const span of [...spans].sort((a, b) => b.offset - a.offset)) {
    if (span.offset < 0 || span.offset + span.length > out.length) continue;
    out = `${out.slice(0, span.offset)}@${assistantName}${out.slice(span.offset + span.length)}`;
  }
  return out;
}

/** Remove mention spans (e.g. the app's own @mention) from text. */
export function removeSpans(text: string, spans: MentionSpan[]): string {
  let out = text;
  for (const span of [...spans].sort((a, b) => b.offset - a.offset)) {
    if (span.offset < 0 || span.offset + span.length > out.length) continue;
    out = out.slice(0, span.offset) + out.slice(span.offset + span.length);
  }
  return out;
}

/** NanoClaw suffixes inbound message ids with `:<agentGroupId>`; Wire ids never contain ':'. */
export function stripAgentSuffix(messageId: string): string {
  const colon = messageId.indexOf(':');
  return colon === -1 ? messageId : messageId.slice(0, colon);
}

export function optionCommand(label: string): string {
  return '/' + label.trim().toLowerCase().replace(/\s+/g, '-');
}

const EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function mimeForFilename(filename: string): string {
  const ext = path.extname(filename).slice(1).toLowerCase();
  return EXT_TO_MIME[ext] ?? 'application/octet-stream';
}

function mediaClass(mimeType: string): string {
  const top = mimeType.split('/')[0];
  return top === 'image' || top === 'audio' || top === 'video' ? top : 'file';
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value as K);
}

function userHandle(user: QualifiedIdLike): string {
  return `${CHANNEL}:${qualifiedKey(user)}`;
}

// ── Worker process ─────────────────────────────────────────────────────────

export type SpawnWorker = (stateDir: string) => ChildProcess;

/** Fork wire-worker next to this module: .js when built, .ts under tsx (pnpm dev). */
export const spawnWorker: SpawnWorker = (stateDir) => {
  const here = fileURLToPath(import.meta.url);
  const isTs = here.endsWith('.ts');
  const entry = path.join(path.dirname(here), isTs ? 'wire-worker.ts' : 'wire-worker.js');
  return fork(entry, [], {
    cwd: stateDir,
    // --import is resolved from cwd, which is the state dir, so pass tsx by URL.
    execArgv: isTs ? ['--import', import.meta.resolve('tsx')] : [],
    serialization: 'advanced',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    // Own process group: terminal Ctrl-C reaches the host, which then shuts the
    // worker down in order. A dead host is detected via IPC disconnect.
    detached: true,
    // Secrets travel over IPC only; keep the host environment out.
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
      NODE_ENV: process.env.NODE_ENV ?? 'production',
      NANOCLAW_WIRE_WORKER: '1',
    },
  });
};

type LaunchOutcome = 'ready' | 'transient' | 'permanent';

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingQuestion {
  questionId: string;
  platformId: string;
  options: NormalizedOption[];
}

export interface WireAdapterDeps {
  spawn: SpawnWorker;
  stateDir: string;
  now: () => number;
}

// ── Adapter ────────────────────────────────────────────────────────────────

export class WireAdapter implements ChannelAdapter {
  readonly name = CHANNEL;
  readonly channelType = CHANNEL;
  readonly supportsThreads = false;
  readonly defaults = WIRE_DEFAULTS;

  private setupConfig?: ChannelSetup;
  private child?: ChildProcess;
  private ready = false;
  private connected = false;
  private stopping = false;
  private setupDone = false;
  private permanentFailure?: { code: WorkerFailureCode; message: string };
  private lastFailure?: { code: WorkerFailureCode; message: string };
  private respawnTimer?: ReturnType<typeof setTimeout>;
  private respawnDelay = RESPAWN_MIN_MS;
  private readySince = 0;
  private nextCallId = 1;
  private readonly calls = new Map<number, PendingCall>();
  private readonly seen = new Map<string, true>();
  /** Recent messages by Wire id, for quoted-reply context. */
  private readonly recent = new Map<string, { sender: string; text: string }>();
  /** Open questions by the Wire id of the message that asked them. */
  private readonly questions = new Map<string, PendingQuestion>();
  /** Latest open question per conversation, for `/option` text replies. */
  private readonly latestQuestion = new Map<string, string>();
  private readonly inboundChains = new Map<string, Promise<void>>();

  constructor(
    private readonly config: WireConfig,
    private readonly deps: WireAdapterDeps,
    private readonly onTornDown: () => void = () => undefined,
  ) {}

  // ── Lifecycle ──

  async setup(config: ChannelSetup): Promise<void> {
    this.setupConfig = config;
    this.stopping = false;
    this.permanentFailure = undefined;
    fs.mkdirSync(this.deps.stateDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.deps.stateDir, 0o700);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), READY_TIMEOUT_MS);
    });
    const outcome = await Promise.race([this.launch(), timeout]);
    clearTimeout(timer);

    if (outcome === 'permanent') {
      const failure = this.permanentFailure ?? this.lastFailure;
      await this.stopChild();
      this.onTornDown();
      throw new Error(
        `Wire channel cannot start (${failure?.code ?? 'unknown'}): ${failure?.message ?? 'worker failed'}`,
      );
    }
    this.setupDone = true;
    if (outcome === 'transient') {
      log.warn('Wire worker failed to start; retrying in the background', { reason: this.lastFailure?.code });
      if (!this.child) this.scheduleRespawn();
    } else if (outcome === 'timeout') {
      log.warn('Wire is still connecting; continuing host startup');
    }
  }

  async teardown(): Promise<void> {
    this.stopping = true;
    if (this.respawnTimer) clearTimeout(this.respawnTimer);
    this.respawnTimer = undefined;
    await this.stopChild();
    this.onTornDown();
  }

  isConnected(): boolean {
    return this.ready && this.connected;
  }

  private launch(): Promise<LaunchOutcome> {
    const child = this.deps.spawn(this.deps.stateDir);
    this.child = child;
    this.ready = false;
    this.connected = false;
    this.lastFailure = undefined;
    let settle!: (outcome: LaunchOutcome) => void;
    const outcome = new Promise<LaunchOutcome>((resolve) => {
      let settled = false;
      settle = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
    });

    child.on('message', (message: WorkerToHost) => this.onWorkerMessage(child, message, settle));
    child.on('exit', (code, signal) => this.onWorkerExit(child, code, signal, settle));
    child.on('error', (err) => log.error('Wire worker process error', { err: describeError(err) }));
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      readline.createInterface({ input: stream }).on('line', (line) => log.debug(`Wire worker: ${redact(line)}`));
    }

    const init: HostToWorker = {
      type: 'init',
      apiHost: this.config.apiHost,
      apiToken: this.config.apiToken,
      cryptoKeyHex: this.config.cryptoKeyHex,
      attachments: this.config.attachments,
    };
    child.send(init);
    return outcome;
  }

  private onWorkerMessage(child: ChildProcess, message: WorkerToHost, settle: (o: LaunchOutcome) => void): void {
    if (child !== this.child) return;
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.connected = true;
        this.readySince = this.deps.now();
        log.info('Wire connected');
        settle('ready');
        break;
      case 'failed': {
        const failure = { code: message.code, message: redact(message.message) };
        this.lastFailure = failure;
        if (PERMANENT_FAILURES.has(message.code)) {
          this.permanentFailure = failure;
          log.error('Wire channel stopped: operator action needed', failure);
          settle('permanent');
        } else {
          log.warn('Wire worker failed', failure);
          settle('transient');
        }
        break;
      }
      case 'connection':
        if (this.ready && this.connected !== message.connected) {
          this.connected = message.connected;
          log.info(message.connected ? 'Wire reconnected' : 'Wire disconnected; the SDK is reconnecting');
        }
        break;
      case 'event':
        this.onEvent(message.event);
        break;
      case 'result': {
        const call = this.calls.get(message.id);
        if (!call) break;
        this.calls.delete(message.id);
        clearTimeout(call.timer);
        if (message.ok) call.resolve(message.value);
        else call.reject(new Error(`Wire: ${redact(message.error)}`));
        break;
      }
      case 'log':
        log[message.level](`Wire: ${redact(message.message)}`);
        break;
    }
  }

  private onWorkerExit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
    settle: (o: LaunchOutcome) => void,
  ): void {
    if (child !== this.child) return;
    this.child = undefined;
    const wasReady = this.ready;
    this.ready = false;
    this.connected = false;
    for (const [id, call] of this.calls) {
      clearTimeout(call.timer);
      call.reject(new Error('Wire worker exited'));
      this.calls.delete(id);
    }
    settle(this.permanentFailure ? 'permanent' : 'transient');
    if (this.stopping || this.permanentFailure || !this.setupDone) return;
    if (wasReady && this.deps.now() - this.readySince >= STABLE_UPTIME_MS) this.respawnDelay = RESPAWN_MIN_MS;
    log.warn('Wire worker exited; restarting', {
      code,
      signal,
      transient: code === EXIT_TRANSIENT,
      reason: this.lastFailure?.code,
    });
    this.scheduleRespawn();
  }

  private scheduleRespawn(): void {
    if (this.respawnTimer || this.child || this.stopping) return;
    const delay = this.respawnDelay;
    this.respawnDelay = Math.min(this.respawnDelay * 2, RESPAWN_MAX_MS);
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = undefined;
      if (this.stopping || this.child) return;
      void this.launch();
    }, delay);
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const within = (ms: number) =>
      Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref())]);
    if (child.connected) child.send({ type: 'shutdown' } satisfies HostToWorker);
    if (await within(SHUTDOWN_GRACE_MS)) return;
    log.warn('Wire worker did not stop in time; sending SIGTERM');
    child.kill('SIGTERM');
    if (await within(KILL_GRACE_MS)) return;
    log.error('Wire worker ignored SIGTERM; killing it');
    child.kill('SIGKILL');
    await within(KILL_GRACE_MS);
  }

  private call<K extends WorkerOp['op']>(op: Extract<WorkerOp, { op: K }>): Promise<WorkerOpResults[K]> {
    const child = this.child;
    if (!child || !this.ready || !child.connected) {
      return Promise.reject(new Error('Wire is not connected'));
    }
    const id = this.nextCallId++;
    const timeoutMs = op.op === 'sendAsset' ? ASSET_CALL_TIMEOUT_MS : CALL_TIMEOUT_MS;
    return new Promise<WorkerOpResults[K]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error(`Wire ${op.op} timed out`));
      }, timeoutMs);
      this.calls.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      child.send({ type: 'call', id, ...op } as HostToWorker);
    });
  }

  // ── Inbound ──

  private onEvent(event: WorkerEvent): void {
    switch (event.kind) {
      case 'text':
        this.onText(event);
        break;
      case 'asset':
        this.onAsset(event);
        break;
      case 'button':
        this.onButton(event);
        break;
      case 'joined':
        this.setupConfig?.onMetadata(qualifiedKey(event.conversation), event.name ?? undefined, event.isGroup);
        break;
      case 'removed':
        log.info('Wire app was removed from a conversation');
        break;
    }
  }

  private firstSighting(messageId: string): boolean {
    if (this.seen.has(messageId)) return false;
    setBounded(this.seen, messageId, true, DEDUPE_MAX);
    return true;
  }

  /** Defence in depth: the worker already discards anything not addressed to the app. */
  private isAddressed(event: InboundText): boolean {
    if (!event.isGroup) return event.addressed === 'dm';
    if (event.addressed === 'mention') return event.appMentions.length > 0;
    return event.addressed === 'reply';
  }

  private onText(event: InboundText): void {
    if (!this.isAddressed(event)) return;
    if (!this.firstSighting(event.messageId)) return;
    const platformId = qualifiedKey(event.conversation);
    const senderName = event.senderName ?? 'Unknown';
    setBounded(this.recent, event.messageId, { sender: senderName, text: event.text }, MESSAGE_CACHE_MAX);

    if (this.answerByText(platformId, event)) return;

    const quoted = event.quotedMessageId ? this.recent.get(event.quotedMessageId) : undefined;
    this.forward(platformId, {
      id: event.messageId,
      kind: 'chat',
      timestamp: event.timestamp,
      isGroup: event.isGroup,
      // Everything that reaches here was addressed to the app.
      isMention: true,
      content: {
        text: rewriteAppMentions(event.text, event.appMentions, this.config.assistantName),
        sender: senderName,
        senderId: userHandle(event.sender),
        senderName: event.senderName,
        ...(quoted && {
          replyTo: { id: event.quotedMessageId, sender: quoted.sender, text: quoted.text.slice(0, QUOTE_MAX_CHARS) },
        }),
      },
    });
  }

  private onAsset(event: InboundAsset): void {
    // Files are only accepted in 1:1 conversations (the worker never sends others).
    if (event.isGroup) return;
    if (!this.firstSighting(event.messageId)) return;
    const platformId = qualifiedKey(event.conversation);
    const attachment: Record<string, unknown> = {
      type: mediaClass(event.mimeType),
      mimeType: event.mimeType,
      size: event.size,
      ...(event.name && { name: event.name }),
      ...(event.data && { data: Buffer.from(event.data).toString('base64') }),
    };
    const notes: Record<string, string> = {
      'too-large': `larger than the ${Math.round(this.config.attachments.maxBytes / 1048576)} MB limit`,
      'no-remote-data': 'no downloadable content',
      'download-failed': 'download failed',
    };
    this.forward(platformId, {
      id: event.messageId,
      kind: 'chat',
      timestamp: event.timestamp,
      isGroup: event.isGroup,
      isMention: true,
      content: {
        text: event.skipped ? `[attachment not downloaded: ${notes[event.skipped]}]` : '',
        sender: event.senderName ?? 'Unknown',
        senderId: userHandle(event.sender),
        senderName: event.senderName,
        attachments: [attachment],
      },
    });
  }

  private onButton(event: InboundButton): void {
    const question = this.questions.get(event.referenceMessageId);
    if (!question) {
      log.debug('Wire button click for an unknown or expired question');
      return;
    }
    const index = Number(event.buttonId.replace(/^o/, ''));
    const option = question.options[index];
    if (!option) return;
    this.resolveQuestion(event.referenceMessageId, question, option, event.sender);
    this.call({
      op: 'confirmButton',
      conversation: event.conversation,
      messageId: event.referenceMessageId,
      buttonId: event.buttonId,
    }).catch((err: unknown) => log.debug('Wire button confirmation failed', { err: describeError(err) }));
  }

  /** `/option` replies answer the conversation's latest open question (clients without button support). */
  private answerByText(platformId: string, event: InboundText): boolean {
    const questionMessageId = this.latestQuestion.get(platformId);
    const question = questionMessageId ? this.questions.get(questionMessageId) : undefined;
    if (!questionMessageId || !question) return false;
    // In groups the reply is addressed (`@app /deny`), so ignore the app's mention spans.
    const typed = removeSpans(event.text, event.appMentions).trim().replace(/\s+/g, ' ').toLowerCase();
    const option = question.options.find((o) => optionCommand(o.label) === typed);
    if (!option) return false;
    this.resolveQuestion(questionMessageId, question, option, event.sender);
    return true;
  }

  private resolveQuestion(
    questionMessageId: string,
    question: PendingQuestion,
    option: NormalizedOption,
    sender: QualifiedIdLike,
  ): void {
    this.questions.delete(questionMessageId);
    if (this.latestQuestion.get(question.platformId) === questionMessageId)
      this.latestQuestion.delete(question.platformId);
    this.setupConfig?.onAction(question.questionId, option.value, userHandle(sender), {
      messageId: questionMessageId,
      platformId: question.platformId,
      threadId: null,
    });
  }

  /** Per-conversation FIFO into the router. */
  private forward(platformId: string, message: InboundMessage): void {
    const setup = this.setupConfig;
    if (!setup) return;
    const prev = this.inboundChains.get(platformId) ?? Promise.resolve();
    const next = prev
      .then(() => setup.onInbound(platformId, null, message))
      .catch((err: unknown) => log.error('Wire inbound routing failed', { err: describeError(err) }));
    this.inboundChains.set(platformId, next);
    void next.then(() => {
      if (this.inboundChains.get(platformId) === next) this.inboundChains.delete(platformId);
    });
  }

  // ── Outbound ──

  async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
    const conversation = parseQualifiedKey(platformId);
    if (!conversation) throw new Error('Wire: platform id is not <uuid>@<domain>');
    const content = (message.content ?? {}) as Record<string, unknown>;

    if (content.operation === 'edit' && typeof content.messageId === 'string') {
      const text = stringField(content, 'text') ?? stringField(content, 'markdown') ?? '';
      return this.call({ op: 'editText', conversation, messageId: stripAgentSuffix(content.messageId), text });
    }
    if (
      content.operation === 'reaction' &&
      typeof content.messageId === 'string' &&
      typeof content.emoji === 'string'
    ) {
      await this.call({
        op: 'react',
        conversation,
        messageId: stripAgentSuffix(content.messageId),
        emoji: content.emoji,
      });
      return undefined;
    }
    if (content.type === 'ask_question') return this.sendQuestion(platformId, conversation, content);

    let text = stringField(content, 'text') ?? stringField(content, 'markdown') ?? '';
    if (content.type === 'card') text = stringField(content, 'fallbackText') ?? cardText(content.card);
    return this.sendParts(conversation, splitText(text), message.files ?? []);
  }

  /**
   * Sends text chunks then files. Nothing sent → throw (the host retries).
   * Partially sent → log and return, since a retry would duplicate what landed.
   */
  private async sendParts(
    conversation: QualifiedIdLike,
    chunks: string[],
    files: NonNullable<OutboundMessage['files']>,
  ): Promise<string | undefined> {
    let firstId: string | undefined;
    const parts = chunks.length + files.length;
    let sent = 0;
    try {
      for (const chunk of chunks) {
        const id = await this.call({ op: 'sendText', conversation, text: chunk });
        setBounded(this.recent, id, { sender: this.config.assistantName, text: chunk }, MESSAGE_CACHE_MAX);
        firstId ??= id;
        sent++;
      }
      for (const file of files) {
        const id = await this.call({
          op: 'sendAsset',
          conversation,
          name: path.basename(file.filename),
          mimeType: mimeForFilename(file.filename),
          data: new Uint8Array(file.data),
        });
        firstId ??= id;
        sent++;
      }
    } catch (err) {
      if (sent === 0) throw err;
      log.error('Wire delivery partially failed; not retrying to avoid duplicates', {
        sent,
        parts,
        err: describeError(err),
      });
    }
    return firstId;
  }

  private async sendQuestion(
    platformId: string,
    conversation: QualifiedIdLike,
    content: Record<string, unknown>,
  ): Promise<string> {
    const options = normalizeOptions(Array.isArray(content.options) ? (content.options as RawOption[]) : []);
    const title = stringField(content, 'title');
    const body = [title && `**${title}**`, stringField(content, 'question')].filter(Boolean).join('\n\n');
    const hint = options.map((o) => optionCommand(o.label)).join('  ');
    const text = options.length ? `${body}\n\n_Tap a button, or reply with: ${hint}_` : body;
    let messageId: string;
    try {
      messageId = await this.call({
        op: 'sendButtons',
        conversation,
        text,
        buttons: options.map((o, i) => ({ id: `o${i}`, text: o.label })),
      });
    } catch (err) {
      log.warn('Wire button message failed; sending a text question', { err: describeError(err) });
      messageId = await this.call({ op: 'sendText', conversation, text });
    }
    const questionId = stringField(content, 'questionId');
    if (questionId && options.length) {
      setBounded(this.questions, messageId, { questionId, platformId, options }, PENDING_QUESTIONS_MAX);
      this.latestQuestion.set(platformId, messageId);
    }
    return messageId;
  }

  // ── Optional capabilities ──

  async openDM(handle: string): Promise<string> {
    const user = parseQualifiedKey(handle);
    if (!user) throw new Error('Wire: user handle is not <uuid>@<domain>');
    return qualifiedKey(await this.call({ op: 'openDM', user }));
  }

  async resolveConversation(platformId: string): Promise<ResolvedConversation | null> {
    const conversation = parseQualifiedKey(platformId);
    if (!conversation || !this.isConnected()) return null;
    const info = await this.call({ op: 'conversationInfo', conversation });
    if (!info) return null;
    return { type: info.kind === 'direct' ? 'direct' : 'channel', name: info.name };
  }
}

function stringField(content: Record<string, unknown>, key: string): string | undefined {
  const value = content[key];
  return typeof value === 'string' ? value : undefined;
}

function cardText(card: unknown): string {
  if (!card || typeof card !== 'object') return '';
  const c = card as { title?: unknown; description?: unknown };
  return [c.title, c.description].filter((v): v is string => typeof v === 'string' && v.length > 0).join('\n\n');
}

// ── Registration ───────────────────────────────────────────────────────────

/** One Wire app identity per install: the SDK state is single-writer. */
let claimed = false;

export function createWireAdapterFromEnv(
  env: Record<string, string | undefined> = readEnvFile(ENV_KEYS),
  deps: Partial<WireAdapterDeps> & { platformProblem?: () => string | null } = {},
): WireAdapter | null {
  if (!env.WIRE_API_HOST && !env.WIRE_API_TOKEN && !env.WIRE_CRYPTO_KEY) return null;
  const config = parseWireConfig(env);
  if (typeof config === 'string') {
    log.error(`Wire channel not started: ${config}`);
    return null;
  }
  const platformProblem = (deps.platformProblem ?? checkPlatform)();
  if (platformProblem) {
    log.error(`Wire channel not started: ${platformProblem}`);
    return null;
  }
  if (claimed) {
    log.warn('Wire channel not started: only one Wire app per NanoClaw install is supported');
    return null;
  }
  claimed = true;
  return new WireAdapter(
    config,
    {
      spawn: deps.spawn ?? spawnWorker,
      stateDir: deps.stateDir ?? path.join(STORE_DIR, 'wire'),
      now: deps.now ?? Date.now,
    },
    () => {
      claimed = false;
    },
  );
}

registerChannelAdapter(CHANNEL, {
  factory: () => createWireAdapterFromEnv(),
  defaults: WIRE_DEFAULTS,
});
