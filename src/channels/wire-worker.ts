/**
 * Wire channel — SDK worker process.
 *
 * Forked by wire.ts with cwd = <store>/wire. This is the ONLY module that
 * loads @wireapp/wire-apps-js-sdk, and it does so with a dynamic import after
 * the host sends `init`, so an SDK that cannot load (unsupported platform,
 * missing package) is reported over IPC instead of crashing anything.
 *
 * Why a separate process: SDK 0.1.0 installs process-wide SIGINT/SIGTERM/
 * uncaughtException/unhandledRejection handlers that call process.exit, keeps
 * its state in cwd-relative ./storage, and uses a process-global DI container.
 * Here all three are harmless — the SDK owns this process, ./storage lands in
 * the channel's state dir, and a crash only costs a respawn.
 *
 * Invariants:
 *  - Single writer: `worker.lock` (O_EXCL + pid) guards the SDK state dir.
 *  - Orphan-safe: if the IPC channel drops (host gone), close and exit.
 *  - SDK event handlers never block: they enqueue per-conversation work and
 *    return, because the SDK awaits them and drops a message whose handler throws.
 *  - Addressed-only: a message is forwarded to the host only if it is for this
 *    app — a 1:1 conversation, an @mention of the app, a reply quoting one of
 *    the app's own messages, or a click on the app's own buttons. Everything
 *    else is discarded here, before any lookup, download or IPC, so no host
 *    setting (engage pattern, 'accumulate') can ever see it.
 *  - Never log message content, file names, keys, tokens or raw ids.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';

import type * as WireSdk from '@wireapp/wire-apps-js-sdk';

import {
  EXIT_PERMANENT,
  EXIT_TRANSIENT,
  PERMANENT_FAILURES,
  decodeCryptoKey,
  describeError,
  qualifiedKey,
  redact,
  sameQualifiedId,
  type AttachmentPolicy,
  type AssetSkipReason,
  type CallMessage,
  type ConversationInfoResult,
  type HostToWorker,
  type InitMessage,
  type QualifiedIdLike,
  type WorkerEvent,
  type WorkerFailureCode,
  type WorkerToHost,
} from './wire-protocol.js';

type SdkModule = typeof WireSdk;

const LOCK_FILE = 'worker.lock';
/** SDK 0.1.0 stops reconnecting after 10 failures and only logs this line. */
const GIVE_UP_PATTERN = /^WebSocket stopped after \d+ failed reconnect attempts/;
/** Backstop when the give-up line changes: no connection for this long → restart. */
const RECONNECT_WATCHDOG_MS = 5 * 60 * 1000;
const USER_NAME_CACHE_MAX = 1000;
const EDIT_MAP_MAX = 1000;
/** Ids of messages this app sent, so replies to them and clicks on them count as addressed. */
const OWN_MESSAGES_MAX = 2000;

// ── IPC helpers ────────────────────────────────────────────────────────────

let sink = (message: WorkerToHost): void => {
  if (process.connected && process.send) process.send(message);
};

/** Tests capture outbound messages here instead of the IPC channel. */
export function setMessageSink(fn: (message: WorkerToHost) => void): void {
  sink = fn;
}

function post(message: WorkerToHost): void {
  sink(message);
}

function log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
  post({ type: 'log', level, message: redact(message) });
}

// ── Single-writer lock ─────────────────────────────────────────────────────

let lockHeld = false;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Take the state-dir lock; break it only if its owner pid is gone. */
export function acquireLock(file = LOCK_FILE): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
      lockHeld = true;
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const owner = Number.parseInt(fs.readFileSync(file, 'utf-8').trim(), 10);
      if (Number.isInteger(owner) && owner !== process.pid && pidAlive(owner)) return false;
      fs.rmSync(file, { force: true });
    }
  }
  return false;
}

function releaseLock(file = LOCK_FILE): void {
  if (!lockHeld) return;
  lockHeld = false;
  fs.rmSync(file, { force: true });
}

// ── Failure classification ─────────────────────────────────────────────────

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH']);

export function classifyError(err: unknown): WorkerFailureCode {
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string } } | undefined;
  const name = e?.name ?? '';
  const message = e?.message ?? String(err);
  const code = e?.code ?? e?.cause?.code ?? '';
  if (name === 'AuthenticationError' || name === 'ForbiddenError') return 'auth';
  if (name === 'InvalidParameterError' || name === 'MissingParameterError') return 'config';
  if (name === 'CryptographicSystemError' || name === 'DatabaseError') return 'state';
  // SelfService: stored app identity differs from the token's app.
  if (/does not match fetched self/i.test(message)) return 'state';
  if (NETWORK_CODES.has(code) || /fetch failed|HTTP request failed|socket hang up|network/i.test(message)) {
    return 'network';
  }
  return 'unknown';
}

// ── Worker ─────────────────────────────────────────────────────────────────

interface ConversationEntry {
  kind: 'direct' | 'group';
  name: string | null;
}

export class WireWorker {
  private sdk?: WireSdk.WireAppSdk;
  private appId?: QualifiedIdLike;
  private readonly conversations = new Map<string, ConversationEntry>();
  private readonly userNames = new Map<string, string>();
  private readonly dmByUser = new Map<string, QualifiedIdLike>();
  /** Wire edits mint a new message id; later edits must replace the latest one. */
  private readonly latestEdit = new Map<string, string>();
  private readonly ownMessages = new Map<string, true>();
  private readonly chains = new Map<string, Promise<void>>();
  private watchdog?: ReturnType<typeof setTimeout>;
  private stopping = false;

  constructor(
    private readonly S: SdkModule,
    private readonly policy: AttachmentPolicy,
  ) {}

  private get manager(): WireSdk.WireApplicationManager {
    if (!this.sdk) throw new Error('Wire SDK is not initialised');
    return this.sdk.getApplicationManager();
  }

  private qid(value: QualifiedIdLike): WireSdk.QualifiedId {
    return new this.S.QualifiedId(value.id, value.domain);
  }

  async start(init: InitMessage): Promise<QualifiedIdLike> {
    const key = decodeCryptoKey(init.cryptoKeyHex);
    const handler = this.createHandler();
    this.sdk = await this.S.WireAppSdk.create(init.apiToken, init.apiHost, key, handler, this.createLogger());
    this.sdk.setBackendConnectionListener({
      onConnected: () => {
        this.clearWatchdog();
        post({ type: 'connection', connected: true });
      },
      onDisconnected: () => {
        post({ type: 'connection', connected: false });
        this.armWatchdog();
      },
    });
    const id = this.manager.getApplicationQualifiedId();
    this.appId = { id: id.id, domain: id.domain };
    await this.refreshConversations();
    // A failed first connect fires no disconnect event, so arm before listening.
    this.armWatchdog();
    await this.sdk.startListening();
    return this.appId;
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.clearWatchdog();
    try {
      this.sdk?.stopListening();
      await this.sdk?.close();
    } catch (err) {
      log('warn', `SDK close failed: ${describeError(err)}`);
    }
  }

  // ── Events ──

  private createHandler(): WireSdk.WireEventsHandler {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const worker = this;
    return new (class extends this.S.WireEventsHandler {
      override async onTextMessageReceived(message: WireSdk.TextMessage): Promise<void> {
        worker.enqueue(message.conversationId, () => worker.handleText(message), 'text');
      }
      override async onAssetMessageReceived(message: WireSdk.AssetMessage): Promise<void> {
        worker.enqueue(message.conversationId, () => worker.handleAsset(message), 'asset');
      }
      override async onButtonClicked(message: WireSdk.CompositeButtonAction): Promise<void> {
        worker.enqueue(message.conversationId, () => worker.handleButton(message), 'button');
      }
      override async onAppAddedToConversation(conversation: WireSdk.Conversation): Promise<void> {
        worker.enqueue(conversation, () => worker.handleJoined(conversation), 'joined');
      }
      override async onConversationDeleted(conversationId: WireSdk.QualifiedId): Promise<void> {
        worker.enqueue(conversationId, () => worker.handleRemoved(conversationId), 'removed');
      }
      // Events the channel doesn't act on are discarded explicitly, so the
      // SDK's default handlers don't even log them.
      override async onTextMessageEdited(): Promise<void> {}
      override async onPingReceived(): Promise<void> {}
      override async onLocationMessageReceived(): Promise<void> {}
      override async onMessageDeleted(): Promise<void> {}
      override async onMessageDelivered(): Promise<void> {}
      override async onMessageReactionReceived(): Promise<void> {}
      override async onUserJoinedConversation(): Promise<void> {}
      override async onUserLeftConversation(
        conversationId: WireSdk.QualifiedId,
        members: WireSdk.QualifiedId[],
      ): Promise<void> {
        if (worker.appId && members.some((m) => sameQualifiedId(m, worker.appId!))) {
          worker.enqueue(conversationId, () => worker.handleRemoved(conversationId), 'removed');
        }
      }
    })();
  }

  /** Per-conversation FIFO so events reach the host in arrival order without blocking the SDK. */
  enqueue(conversation: QualifiedIdLike, work: () => Promise<void>, kind: string): void {
    const key = qualifiedKey(conversation);
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev
      .then(work)
      .catch((err: unknown) => log('error', `inbound ${kind} handling failed: ${describeError(err)}`));
    this.chains.set(key, next);
    void next.then(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
  }

  private emit(event: WorkerEvent): void {
    post({ type: 'event', event });
  }

  private isSelf(sender: QualifiedIdLike | undefined): boolean {
    return !sender || (this.appId !== undefined && sameQualifiedId(sender, this.appId));
  }

  async handleText(message: WireSdk.TextMessage): Promise<void> {
    if (this.isSelf(message.sender)) return;
    const conversation = await this.conversationEntry(message.conversationId);
    if (!conversation) return;
    const appId = this.appId!;
    const appMentions = (message.mentions ?? [])
      .filter((m) => sameQualifiedId(m.userId, appId))
      .map((m) => ({ offset: m.offset, length: m.length }));
    const addressed =
      conversation.kind === 'direct'
        ? 'dm'
        : appMentions.length > 0
          ? 'mention'
          : message.quotedMessageId && this.ownMessages.has(message.quotedMessageId)
            ? 'reply'
            : null;
    // Not for us: discard. No sender lookup, no IPC, no log line.
    if (!addressed) return;
    this.emit({
      kind: 'text',
      messageId: message.id,
      conversation: plain(message.conversationId),
      sender: plain(message.sender!),
      senderName: await this.userName(message.sender!),
      isGroup: conversation.kind === 'group',
      timestamp: isoTimestamp(message.timestamp),
      text: message.text,
      addressed,
      appMentions,
      quotedMessageId: message.quotedMessageId ?? undefined,
    });
  }

  async handleAsset(message: WireSdk.AssetMessage): Promise<void> {
    if (this.isSelf(message.sender)) return;
    const conversation = await this.conversationEntry(message.conversationId);
    // Wire files carry no mention or quote, so in a group they can't be
    // addressed to the app: discard without downloading. Files go by DM.
    if (conversation?.kind !== 'direct') return;
    const size = toNumber(message.sizeInBytes);
    let data: Uint8Array | undefined;
    let skipped: AssetSkipReason | undefined;
    if (size > this.policy.maxBytes) skipped = 'too-large';
    else if (!message.remoteData) skipped = 'no-remote-data';
    else {
      try {
        data = await this.manager.downloadAsset(message.remoteData);
        if (data.byteLength > this.policy.maxBytes) {
          data = undefined;
          skipped = 'too-large';
        }
      } catch (err) {
        log('warn', `asset download failed: ${describeError(err)}`);
        skipped = 'download-failed';
      }
    }
    this.emit({
      kind: 'asset',
      messageId: message.id,
      conversation: plain(message.conversationId),
      sender: plain(message.sender!),
      senderName: await this.userName(message.sender!),
      isGroup: false,
      timestamp: isoTimestamp(message.timestamp),
      name: message.name ?? null,
      mimeType: message.mimeType,
      size,
      data,
      skipped,
    });
  }

  async handleButton(message: WireSdk.CompositeButtonAction): Promise<void> {
    if (this.isSelf(message.sender)) return;
    // Only clicks on buttons this app sent.
    if (!this.ownMessages.has(message.referenceMessageId)) return;
    const conversation = await this.conversationEntry(message.conversationId);
    if (!conversation) return;
    this.emit({
      kind: 'button',
      conversation: plain(message.conversationId),
      sender: plain(message.sender!),
      isGroup: conversation.kind === 'group',
      referenceMessageId: message.referenceMessageId,
      buttonId: message.buttonId,
    });
  }

  async handleJoined(conversation: WireSdk.Conversation): Promise<void> {
    const entry = this.toEntry(conversation);
    if (!entry) return;
    this.conversations.set(qualifiedKey(conversation), entry);
    this.emit({
      kind: 'joined',
      conversation: { id: conversation.id, domain: conversation.domain },
      name: entry.name,
      isGroup: entry.kind === 'group',
    });
  }

  async handleRemoved(conversationId: QualifiedIdLike): Promise<void> {
    this.conversations.delete(qualifiedKey(conversationId));
    for (const [user, dm] of this.dmByUser) if (sameQualifiedId(dm, conversationId)) this.dmByUser.delete(user);
    this.emit({ kind: 'removed', conversation: plain(conversationId) });
  }

  // ── Local state ──

  private toEntry(conversation: WireSdk.Conversation): ConversationEntry | null {
    if (conversation.type === this.S.ConversationType.ONE_TO_ONE) return { kind: 'direct', name: conversation.name };
    if (conversation.type === this.S.ConversationType.GROUP) return { kind: 'group', name: conversation.name };
    return null;
  }

  private async refreshConversations(): Promise<void> {
    for (const conversation of await this.manager.getAllConversations()) {
      const entry = this.toEntry(conversation);
      if (entry) this.conversations.set(qualifiedKey(conversation), entry);
    }
  }

  private async conversationEntry(conversation: QualifiedIdLike): Promise<ConversationEntry | undefined> {
    const key = qualifiedKey(conversation);
    if (!this.conversations.has(key)) await this.refreshConversations();
    return this.conversations.get(key);
  }

  private async userName(user: QualifiedIdLike): Promise<string | undefined> {
    const key = qualifiedKey(user);
    const cached = this.userNames.get(key);
    if (cached !== undefined) return cached || undefined;
    let name = '';
    try {
      const [found] = await this.manager.getUsers([this.qid(user)]);
      name = found?.name ?? '';
    } catch (err) {
      log('debug', `user lookup failed: ${describeError(err)}`);
      return undefined;
    }
    setBounded(this.userNames, key, name, USER_NAME_CACHE_MAX);
    return name || undefined;
  }

  // ── Calls from the host ──

  async call(message: CallMessage): Promise<unknown> {
    const result = await this.dispatch(message);
    if (typeof result === 'string' && message.op !== 'react' && message.op !== 'confirmButton') {
      setBounded(this.ownMessages, result, true, OWN_MESSAGES_MAX);
    }
    return result;
  }

  private async dispatch(message: CallMessage): Promise<unknown> {
    const S = this.S;
    switch (message.op) {
      case 'sendText':
        return this.manager.sendMessage(
          S.TextMessage.create({ conversationId: this.qid(message.conversation), text: message.text }),
        );
      case 'sendAsset':
        return this.manager.sendAsset(this.qid(message.conversation), {
          data: message.data,
          name: message.name,
          mimeType: message.mimeType,
        });
      case 'editText': {
        const replacingMessageId = this.latestEdit.get(message.messageId) ?? message.messageId;
        const newId = await this.manager.sendMessage(
          S.TextEditedMessage.create({
            conversationId: this.qid(message.conversation),
            replacingMessageId,
            text: message.text,
          }),
        );
        setBounded(this.latestEdit, message.messageId, newId, EDIT_MAP_MAX);
        return newId;
      }
      case 'react':
        return this.manager.sendMessage(
          S.Reaction.create({
            conversationId: this.qid(message.conversation),
            messageId: this.latestEdit.get(message.messageId) ?? message.messageId,
            emojiSet: new Set([message.emoji]),
          }),
        );
      case 'sendButtons':
        return this.manager.sendMessage(
          S.CompositeMessage.create({
            conversationId: this.qid(message.conversation),
            text: message.text,
            itemList: message.buttons.map((b) => S.CompositeButton.create({ id: b.id, text: b.text })),
          }),
        );
      case 'confirmButton':
        // CompositeButtonActionConfirmation isn't exported by 0.1.0; its create()
        // only builds this object, which the serializer accepts.
        return this.manager.sendMessage({
          type: S.WireMessageType.COMPOSITE_BUTTON_ACTION_CONFIRMATION,
          id: randomUUID(),
          conversationId: this.qid(message.conversation),
          referenceMessageId: message.messageId,
          buttonId: message.buttonId,
        } as unknown as WireSdk.WireMessage);
      case 'openDM':
        return this.openDM(message.user);
      case 'conversationInfo': {
        const entry = await this.conversationEntry(message.conversation);
        return entry ? ({ kind: entry.kind, name: entry.name } satisfies ConversationInfoResult) : null;
      }
    }
  }

  private async openDM(user: QualifiedIdLike): Promise<QualifiedIdLike> {
    const userKey = qualifiedKey(user);
    const cached = this.dmByUser.get(userKey);
    if (cached) return cached;
    const manager = this.manager;
    for (const conversation of await manager.getAllConversations()) {
      if (conversation.type !== this.S.ConversationType.ONE_TO_ONE) continue;
      const members = await manager.getMembersInConversation(this.qid(conversation));
      if (members.some((m) => qualifiedKey(m.userId) === userKey)) {
        const found = { id: conversation.id, domain: conversation.domain };
        this.dmByUser.set(userKey, found);
        return found;
      }
    }
    let created: QualifiedIdLike;
    try {
      created = plain(await manager.createOneToOneConversation(this.qid(user)));
    } catch (err) {
      // Apps can't send or accept connection requests, so they can only open a
      // 1:1 with members of their own team (verified on staging).
      if (/not.connected/i.test(String((err as Error)?.message))) {
        throw new Error("Wire: can't open a 1:1 with that user: apps can only DM members of their own team", {
          cause: err,
        });
      }
      throw err;
    }
    this.conversations.set(qualifiedKey(created), { kind: 'direct', name: null });
    this.dmByUser.set(userKey, created);
    return created;
  }

  // ── Connection health ──

  private createLogger(): WireSdk.Logger {
    const describeMeta = (meta: unknown[]) => {
      const errors = meta.filter((m): m is Error => m instanceof Error).map((e) => e.message);
      return errors.length ? ` (${errors.join('; ')})` : '';
    };
    // Debug lines dump raw payloads and info lines carry ids: drop and demote.
    return {
      debug: () => undefined,
      info: (message) => log('debug', `[sdk] ${message}`),
      warn: (message, ...meta) => log('warn', `[sdk] ${message}${describeMeta(meta)}`),
      error: (message, ...meta) => {
        log('error', `[sdk] ${message}${describeMeta(meta)}`);
        if (GIVE_UP_PATTERN.test(message)) void fail('gave-up', 'SDK stopped reconnecting');
      },
    };
  }

  private armWatchdog(): void {
    if (this.watchdog || this.stopping) return;
    this.watchdog = setTimeout(() => {
      this.watchdog = undefined;
      void fail('gave-up', `no backend connection for ${RECONNECT_WATCHDOG_MS / 60000} minutes`);
    }, RECONNECT_WATCHDOG_MS);
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = undefined;
  }
}

/**
 * SDK 0.1.0 declares `timestamp: Date`, but received messages carry the backend
 * event's `time` string. Accept both; fall back to now if it's unparseable.
 */
export function isoTimestamp(value: unknown): string {
  const date =
    value instanceof Date ? value : new Date(typeof value === 'string' || typeof value === 'number' ? value : NaN);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function plain(id: QualifiedIdLike): QualifiedIdLike {
  return { id: id.id, domain: id.domain };
}

function toNumber(value: number | { toNumber(): number }): number {
  return typeof value === 'number' ? value : value.toNumber();
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value as K);
}

// ── Process entry ──────────────────────────────────────────────────────────

let worker: WireWorker | undefined;
let exiting = false;

async function exitWith(code: number): Promise<never> {
  if (!exiting) {
    exiting = true;
    await worker?.stop();
    releaseLock();
  }
  process.exit(code);
}

async function fail(code: WorkerFailureCode, message: string): Promise<never> {
  post({ type: 'failed', code, message: redact(message) });
  return exitWith(PERMANENT_FAILURES.has(code) ? EXIT_PERMANENT : EXIT_TRANSIENT);
}

async function handleInit(init: InitMessage): Promise<void> {
  if (!acquireLock()) return void (await fail('locked', 'another Wire worker owns the state directory'));
  let S: SdkModule;
  try {
    S = await import('@wireapp/wire-apps-js-sdk');
  } catch (err) {
    return void (await fail('platform', `cannot load the Wire SDK: ${describeError(err)}`));
  }
  worker = new WireWorker(S, init.attachments);
  try {
    const appId = await worker.start(init);
    post({ type: 'ready', appId });
  } catch (err) {
    await fail(classifyError(err), describeError(err));
  }
}

async function handleCall(message: CallMessage): Promise<void> {
  try {
    if (!worker) throw new Error('worker not initialised');
    const value = await worker.call(message);
    post({ type: 'result', id: message.id, ok: true, value });
  } catch (err) {
    post({ type: 'result', id: message.id, ok: false, error: describeError(err) });
  }
}

function main(): void {
  if (!process.send) {
    console.error('wire-worker must be started by the NanoClaw Wire channel (IPC required)');
    process.exit(EXIT_PERMANENT);
  }
  // Last-resort lock cleanup for exits we don't control (the SDK's own exit handlers).
  process.on('exit', () => releaseLock());
  // Host gone (crash, SIGKILL, KillMode=process): don't linger as a second writer.
  process.on('disconnect', () => void exitWith(0));
  process.on('message', (message: HostToWorker) => {
    switch (message.type) {
      case 'init':
        void handleInit(message);
        break;
      case 'call':
        void handleCall(message);
        break;
      case 'shutdown':
        void exitWith(0);
        break;
    }
  });
}

// Only run as a forked entry point, never when imported by tests.
if (process.env.NANOCLAW_WIRE_WORKER === '1') main();
