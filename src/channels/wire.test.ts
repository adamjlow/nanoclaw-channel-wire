import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
// The host adapter must never load the SDK: if anything imports it, this throws.
vi.mock('@wireapp/wire-apps-js-sdk', () => {
  throw new Error('the Wire SDK must not load in the NanoClaw host process');
});

import type { ChannelSetup } from './adapter.js';
import {
  WIRE_TEXT_LIMIT,
  WireAdapter,
  checkPlatform,
  createWireAdapterFromEnv,
  mimeForFilename,
  optionCommand,
  parseWireConfig,
  rewriteAppMentions,
  splitText,
  stripAgentSuffix,
  type WireConfig,
} from './wire.js';
import type { HostToWorker, WorkerEvent, WorkerToHost } from './wire-protocol.js';

const CONV = { id: '11111111-1111-4111-8111-111111111111', domain: 'wire.example' };
const USER = { id: '22222222-2222-4222-8222-222222222222', domain: 'wire.example' };
const APP = { id: '33333333-3333-4333-8333-333333333333', domain: 'wire.example' };
const PLATFORM_ID = `${CONV.id}@${CONV.domain}`;
const SENDER_ID = `wire:${USER.id}@${USER.domain}`;
const KEY = 'ab'.repeat(32);

// ── Fake worker process ────────────────────────────────────────────────────

type Responder = (message: HostToWorker, child: FakeChild) => void;

class FakeChild extends EventEmitter {
  sent: HostToWorker[] = [];
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = null;
  stderr = null;

  constructor(private readonly respond: Responder) {
    super();
  }

  send(message: HostToWorker): boolean {
    this.sent.push(message);
    queueMicrotask(() => this.respond(message, this));
    return true;
  }

  reply(message: WorkerToHost): void {
    this.emit('message', message);
  }

  event(event: WorkerEvent): void {
    this.reply({ type: 'event', event });
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.exit(null, signal);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.connected = false;
    this.emit('exit', code, signal);
  }

  calls(op?: string): Array<Extract<HostToWorker, { type: 'call' }>> {
    return this.sent.filter(
      (m): m is Extract<HostToWorker, { type: 'call' }> => m.type === 'call' && (!op || m.op === op),
    );
  }
}

let sentCount = 0;
const healthy: Responder = (message, child) => {
  if (message.type === 'init') child.reply({ type: 'ready', appId: APP });
  if (message.type === 'shutdown') child.exit(0);
  if (message.type === 'call') {
    const value =
      message.op === 'openDM'
        ? CONV
        : message.op === 'conversationInfo'
          ? { kind: 'group', name: 'Team' }
          : `m${++sentCount}`;
    child.reply({ type: 'result', id: message.id, ok: true, value });
  }
};

const config: WireConfig = {
  apiHost: 'https://nginz.wire.example',
  apiToken: 'token',
  cryptoKeyHex: KEY,
  attachments: { maxBytes: 1024 * 1024 },
  assistantName: 'Andy',
};

let stateDir: string;
let children: FakeChild[];
let setupConfig: { [K in keyof ChannelSetup]: ReturnType<typeof vi.fn> };

function makeAdapter(respond: Responder = healthy, now = () => Date.now()) {
  const adapter = new WireAdapter(config, {
    stateDir,
    now,
    spawn: () => {
      const child = new FakeChild(respond);
      children.push(child);
      return child as unknown as ChildProcess;
    },
  });
  return adapter;
}

async function started(respond: Responder = healthy) {
  const adapter = makeAdapter(respond);
  await adapter.setup(setupConfig as unknown as ChannelSetup);
  return { adapter, child: children[children.length - 1] };
}

/** Let queued microtasks and IPC fakes settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-test-'));
  children = [];
  sentCount = 0;
  setupConfig = { onInbound: vi.fn(), onInboundEvent: vi.fn(), onMetadata: vi.fn(), onAction: vi.fn() };
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

// ── Pure helpers ───────────────────────────────────────────────────────────

describe('helpers', () => {
  it('splits long text on paragraph boundaries within the Wire limit', () => {
    const para = 'x'.repeat(5000);
    const chunks = splitText(`${para}\n\n${para}`);
    expect(chunks).toEqual([para, para]);
    expect(splitText('y'.repeat(WIRE_TEXT_LIMIT * 2 + 5)).map((c) => c.length)).toEqual([
      WIRE_TEXT_LIMIT,
      WIRE_TEXT_LIMIT,
      5,
    ]);
    expect(splitText('')).toEqual([]);
  });

  it('rewrites app mention spans to the assistant name', () => {
    expect(
      rewriteAppMentions(
        'hi @WireBot and @WireBot!',
        [
          { offset: 3, length: 8 },
          { offset: 16, length: 8 },
        ],
        'Andy',
      ),
    ).toBe('hi @Andy and @Andy!');
    expect(rewriteAppMentions('short', [{ offset: 3, length: 50 }], 'Andy')).toBe('short');
  });

  it('strips the agent-group suffix NanoClaw adds to inbound ids', () => {
    expect(stripAgentSuffix('abc-123:ag-7')).toBe('abc-123');
    expect(stripAgentSuffix('abc-123')).toBe('abc-123');
  });

  it('maps option labels to slash commands and filenames to MIME types', () => {
    expect(optionCommand('Approve once')).toBe('/approve-once');
    expect(mimeForFilename('report.PDF')).toBe('application/pdf');
    expect(mimeForFilename('blob')).toBe('application/octet-stream');
  });
});

describe('parseWireConfig', () => {
  const env = { WIRE_API_HOST: 'https://nginz.wire.example/', WIRE_API_TOKEN: 't', WIRE_CRYPTO_KEY: KEY };

  it('accepts a complete config with defaults', () => {
    expect(parseWireConfig(env)).toMatchObject({
      apiHost: 'https://nginz.wire.example',
      attachments: { maxBytes: 25 * 1024 * 1024 },
      assistantName: 'Andy',
    });
  });

  it('explains what is wrong without echoing secrets', () => {
    expect(parseWireConfig({ ...env, WIRE_API_TOKEN: undefined })).toBe('missing WIRE_API_TOKEN in .env');
    expect(parseWireConfig({ ...env, WIRE_API_HOST: 'http://nginz' })).toMatch(/https/);
    const bad = parseWireConfig({ ...env, WIRE_CRYPTO_KEY: 'nothex' });
    expect(bad).toMatch(/64 hex/);
    expect(bad).not.toContain('nothex');
    expect(parseWireConfig({ ...env, WIRE_MAX_ATTACHMENT_MB: 'lots' })).toMatch(/MB/);
  });
});

describe('checkPlatform', () => {
  it('allows Linux x64 with glibc >= 2.38 and macOS arm64 only', () => {
    expect(checkPlatform('linux', 'x64', '2.38')).toBeNull();
    expect(checkPlatform('linux', 'x64', '2.41')).toBeNull();
    expect(checkPlatform('darwin', 'arm64', null)).toBeNull();
    expect(checkPlatform('linux', 'x64', '2.35')).toMatch(/2\.38/);
    expect(checkPlatform('linux', 'x64', null)).toMatch(/musl/);
    expect(checkPlatform('linux', 'arm64', '2.39')).toMatch(/x86_64/);
    expect(checkPlatform('darwin', 'x64', null)).toMatch(/Apple Silicon/);
    expect(checkPlatform('win32', 'x64', null)).toMatch(/not supported/);
  });
});

describe('createWireAdapterFromEnv', () => {
  const env = { WIRE_API_HOST: 'https://nginz.wire.example', WIRE_API_TOKEN: 't', WIRE_CRYPTO_KEY: KEY };
  const ok = { platformProblem: () => null };

  it('declines when Wire is not configured, misconfigured, or unsupported here', () => {
    expect(createWireAdapterFromEnv({}, ok)).toBeNull();
    expect(createWireAdapterFromEnv({ ...env, WIRE_CRYPTO_KEY: 'short' }, ok)).toBeNull();
    expect(createWireAdapterFromEnv(env, { platformProblem: () => 'nope' })).toBeNull();
  });

  it('allows one Wire app per install until the first is torn down', async () => {
    const first = createWireAdapterFromEnv(env, { ...ok, stateDir });
    expect(first).toBeInstanceOf(WireAdapter);
    expect(createWireAdapterFromEnv(env, ok)).toBeNull();
    await first!.teardown();
    const again = createWireAdapterFromEnv(env, { ...ok, stateDir });
    expect(again).toBeInstanceOf(WireAdapter);
    await again!.teardown();
  });
});

// ── Lifecycle ──────────────────────────────────────────────────────────────

describe('lifecycle', () => {
  it('starts the worker with credentials over IPC and reports connected', async () => {
    const { adapter, child } = await started();
    expect(adapter.isConnected()).toBe(true);
    expect(child.sent[0]).toMatchObject({
      type: 'init',
      apiHost: config.apiHost,
      apiToken: 'token',
      cryptoKeyHex: KEY,
    });
    expect(fs.statSync(stateDir).mode & 0o777).toBe(0o700);
    await adapter.teardown();
  });

  it('throws on a permanent failure so the operator sees it', async () => {
    const adapter = makeAdapter((message, child) => {
      if (message.type !== 'init') return;
      child.reply({ type: 'failed', code: 'auth', message: 'token expired' });
      child.exit(78);
    });
    await expect(adapter.setup(setupConfig as unknown as ChannelSetup)).rejects.toThrow(/auth.*token expired/);
    expect(adapter.isConnected()).toBe(false);
  });

  it('keeps booting on a transient failure and respawns with backoff', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const adapter = makeAdapter((message, child) => {
      if (message.type === 'shutdown') child.exit(0);
      if (message.type !== 'init') return;
      if (++attempts === 1) {
        child.reply({ type: 'failed', code: 'network', message: 'fetch failed' });
        child.exit(75);
      } else {
        child.reply({ type: 'ready', appId: APP });
      }
    });
    await adapter.setup(setupConfig as unknown as ChannelSetup);
    expect(adapter.isConnected()).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(children).toHaveLength(2);
    expect(adapter.isConnected()).toBe(true);
    await adapter.teardown();
  });

  it('respawns a worker that dies after connecting, but not during teardown', async () => {
    vi.useFakeTimers();
    const { adapter, child } = await started();
    child.exit(1);
    expect(adapter.isConnected()).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(children).toHaveLength(2);
    expect(adapter.isConnected()).toBe(true);

    await adapter.teardown();
    expect(children[1].sent.at(-1)).toEqual({ type: 'shutdown' });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(children).toHaveLength(2);
  });

  it('tracks backend connection state from the worker', async () => {
    const { adapter, child } = await started();
    child.reply({ type: 'connection', connected: false });
    expect(adapter.isConnected()).toBe(false);
    child.reply({ type: 'connection', connected: true });
    expect(adapter.isConnected()).toBe(true);
    await adapter.teardown();
  });

  it('escalates to SIGTERM when the worker ignores shutdown', async () => {
    vi.useFakeTimers();
    const { adapter, child } = await started((message, c) => {
      if (message.type === 'init') c.reply({ type: 'ready', appId: APP });
    });
    const kill = vi.spyOn(child, 'kill');
    const done = adapter.teardown();
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });
});

// ── Inbound ────────────────────────────────────────────────────────────────

describe('inbound', () => {
  const text = (overrides: Partial<Extract<WorkerEvent, { kind: 'text' }>> = {}): WorkerEvent => ({
    kind: 'text',
    messageId: 'msg-1',
    conversation: CONV,
    sender: USER,
    senderName: 'Alice',
    isGroup: false,
    timestamp: '2026-09-26T10:00:00.000Z',
    text: 'hello',
    addressed: 'dm',
    appMentions: [],
    ...overrides,
  });

  it('maps a DM to a mention with a namespaced sender', async () => {
    const { adapter, child } = await started();
    child.event(text());
    await flush();
    expect(setupConfig.onInbound).toHaveBeenCalledWith(PLATFORM_ID, null, {
      id: 'msg-1',
      kind: 'chat',
      timestamp: '2026-09-26T10:00:00.000Z',
      isGroup: false,
      isMention: true,
      content: { text: 'hello', sender: 'Alice', senderId: SENDER_ID, senderName: 'Alice' },
    });
    await adapter.teardown();
  });

  it('forwards addressed group messages (mention or reply) as mentions', async () => {
    const { adapter, child } = await started();
    child.event(
      text({
        messageId: 'g1',
        isGroup: true,
        text: '@Bot help',
        addressed: 'mention',
        appMentions: [{ offset: 0, length: 4 }],
      }),
    );
    child.event(text({ messageId: 'g2', isGroup: true, text: 'thanks', addressed: 'reply', quotedMessageId: 'mine' }));
    await flush();
    const [mention, reply] = setupConfig.onInbound.mock.calls.map((c) => c[2]);
    expect(mention).toMatchObject({ isGroup: true, isMention: true, content: { text: '@Andy help' } });
    expect(reply).toMatchObject({ isGroup: true, isMention: true, content: { text: 'thanks' } });
    await adapter.teardown();
  });

  it('never routes unaddressed group chatter, even if the worker sent it (defence in depth)', async () => {
    const { adapter, child } = await started();
    // A group message claiming to be a DM, and a "mention" with no mention span.
    child.event(text({ messageId: 'x1', isGroup: true, addressed: 'dm' }));
    child.event(text({ messageId: 'x2', isGroup: true, addressed: 'mention', appMentions: [] }));
    await flush();
    expect(setupConfig.onInbound).not.toHaveBeenCalled();
    await adapter.teardown();
  });

  it('drops duplicate deliveries of the same message id', async () => {
    const { adapter, child } = await started();
    child.event(text());
    child.event(text());
    await flush();
    expect(setupConfig.onInbound).toHaveBeenCalledTimes(1);
    await adapter.teardown();
  });

  it('adds quoted-reply context from recent messages', async () => {
    const { adapter, child } = await started();
    child.event(text({ messageId: 'orig', text: 'the original' }));
    child.event(text({ messageId: 'reply', text: 'agreed', quotedMessageId: 'orig' }));
    await flush();
    expect(setupConfig.onInbound.mock.calls[1][2].content.replyTo).toEqual({
      id: 'orig',
      sender: 'Alice',
      text: 'the original',
    });
    await adapter.teardown();
  });

  it('passes downloaded files as base64 for core to stage, and notes skipped ones', async () => {
    const { adapter, child } = await started();
    child.event({
      kind: 'asset',
      messageId: 'a1',
      conversation: CONV,
      sender: USER,
      isGroup: false,
      timestamp: '2026-09-26T10:00:00.000Z',
      name: 'notes.pdf',
      mimeType: 'application/pdf',
      size: 3,
      data: new Uint8Array([1, 2, 3]),
    });
    child.event({
      kind: 'asset',
      messageId: 'a2',
      conversation: CONV,
      sender: USER,
      isGroup: false,
      timestamp: '2026-09-26T10:00:00.000Z',
      name: null,
      mimeType: 'image/png',
      size: 10_000_000,
      skipped: 'too-large',
    });
    // Group files are never accepted.
    child.event({
      kind: 'asset',
      messageId: 'a3',
      conversation: CONV,
      sender: USER,
      isGroup: true,
      timestamp: '2026-09-26T10:00:00.000Z',
      name: 'leak.pdf',
      mimeType: 'application/pdf',
      size: 3,
      data: new Uint8Array([1, 2, 3]),
    });
    await flush();
    expect(setupConfig.onInbound).toHaveBeenCalledTimes(2);
    const [dm, big] = setupConfig.onInbound.mock.calls.map((c) => c[2]);
    expect(dm.content.attachments).toEqual([
      { type: 'file', mimeType: 'application/pdf', size: 3, name: 'notes.pdf', data: 'AQID' },
    ]);
    expect(dm.isMention).toBe(true);
    expect(big.content.text).toMatch(/not downloaded: larger than the 1 MB limit/);
    expect(big.content.attachments[0]).not.toHaveProperty('data');
    await adapter.teardown();
  });

  it('reports conversations the app joins as metadata', async () => {
    const { adapter, child } = await started();
    child.event({ kind: 'joined', conversation: CONV, name: 'Team', isGroup: true });
    expect(setupConfig.onMetadata).toHaveBeenCalledWith(PLATFORM_ID, 'Team', true);
    await adapter.teardown();
  });
});

// ── Outbound ───────────────────────────────────────────────────────────────

describe('deliver', () => {
  it('sends text in chunks and returns the first Wire message id', async () => {
    const { adapter, child } = await started();
    const para = 'z'.repeat(6000);
    const id = await adapter.deliver(PLATFORM_ID, null, { kind: 'chat', content: { text: `${para}\n\n${para}` } });
    expect(id).toBe('m1');
    expect(child.calls('sendText').map((c) => c.op === 'sendText' && c.conversation)).toEqual([CONV, CONV]);
    await adapter.teardown();
  });

  it('sends files after the text with a MIME type from the filename', async () => {
    const { adapter, child } = await started();
    await adapter.deliver(PLATFORM_ID, null, {
      kind: 'chat',
      content: { text: 'here' },
      files: [{ filename: 'chart.png', data: Buffer.from([9]) }],
    });
    const [asset] = child.calls('sendAsset');
    expect(asset).toMatchObject({ op: 'sendAsset', name: 'chart.png', mimeType: 'image/png', conversation: CONV });
    await adapter.teardown();
  });

  it('throws when Wire is offline so the host retries', async () => {
    const { adapter, child } = await started();
    child.reply({ type: 'connection', connected: false });
    child.exit(1);
    await expect(adapter.deliver(PLATFORM_ID, null, { kind: 'chat', content: { text: 'hi' } })).rejects.toThrow(
      /not connected/,
    );
    await adapter.teardown();
  });

  it('does not throw after a partial send, to avoid duplicates on retry', async () => {
    const { adapter } = await started((message, child) => {
      if (message.type === 'init') child.reply({ type: 'ready', appId: APP });
      if (message.type === 'shutdown') child.exit(0);
      if (message.type === 'call') {
        const ok = message.op === 'sendText';
        child.reply(
          ok
            ? { type: 'result', id: message.id, ok, value: 'text-id' }
            : { type: 'result', id: message.id, ok, error: 'upload failed' },
        );
      }
    });
    const id = await adapter.deliver(PLATFORM_ID, null, {
      kind: 'chat',
      content: { text: 'caption' },
      files: [{ filename: 'a.txt', data: Buffer.from('x') }],
    });
    expect(id).toBe('text-id');
    await adapter.teardown();
  });

  it('rejects platform ids that are not Wire conversations', async () => {
    const { adapter } = await started();
    await expect(adapter.deliver('not-wire', null, { kind: 'chat', content: { text: 'x' } })).rejects.toThrow(/uuid/);
    await adapter.teardown();
  });

  it('edits and reacts to the Wire id without the agent-group suffix', async () => {
    const { adapter, child } = await started();
    await adapter.deliver(PLATFORM_ID, null, {
      kind: 'chat',
      content: { operation: 'edit', messageId: 'w1:ag-1', text: 'new' },
    });
    await adapter.deliver(PLATFORM_ID, null, {
      kind: 'chat',
      content: { operation: 'reaction', messageId: 'w2:ag-1', emoji: '👍' },
    });
    expect(child.calls('editText')[0]).toMatchObject({ messageId: 'w1', text: 'new' });
    expect(child.calls('react')[0]).toMatchObject({ messageId: 'w2', emoji: '👍' });
    await adapter.teardown();
  });

  it('renders a card as its fallback text', async () => {
    const { adapter, child } = await started();
    await adapter.deliver(PLATFORM_ID, null, {
      kind: 'chat',
      content: { type: 'card', card: {}, fallbackText: 'plain' },
    });
    expect(child.calls('sendText')[0]).toMatchObject({ text: 'plain' });
    await adapter.teardown();
  });
});

describe('questions', () => {
  const question = {
    type: 'ask_question',
    questionId: 'q-1',
    title: 'Approve?',
    question: 'Allow the agent to install a package?',
    options: [{ label: 'Approve', value: 'yes' }, 'Deny'],
  };

  it('asks with Wire buttons and resolves a click through onAction, then confirms it', async () => {
    const { adapter, child } = await started();
    const id = await adapter.deliver(PLATFORM_ID, null, { kind: 'chat', content: question });
    const [buttons] = child.calls('sendButtons');
    expect(buttons).toMatchObject({
      buttons: [
        { id: 'o0', text: 'Approve' },
        { id: 'o1', text: 'Deny' },
      ],
    });
    expect(buttons.op === 'sendButtons' && buttons.text).toContain('/approve');

    child.event({
      kind: 'button',
      conversation: CONV,
      sender: USER,
      isGroup: false,
      referenceMessageId: id!,
      buttonId: 'o0',
    });
    await flush();
    expect(setupConfig.onAction).toHaveBeenCalledWith('q-1', 'yes', SENDER_ID, {
      messageId: id,
      platformId: PLATFORM_ID,
      threadId: null,
    });
    expect(child.calls('confirmButton')[0]).toMatchObject({ messageId: id, buttonId: 'o0' });

    // Answered questions don't resolve twice.
    child.event({
      kind: 'button',
      conversation: CONV,
      sender: USER,
      isGroup: false,
      referenceMessageId: id!,
      buttonId: 'o1',
    });
    expect(setupConfig.onAction).toHaveBeenCalledTimes(1);
    await adapter.teardown();
  });

  it('accepts a /option text reply without forwarding it to the agent', async () => {
    const { adapter, child } = await started();
    await adapter.deliver(PLATFORM_ID, null, { kind: 'chat', content: question });
    child.event({
      kind: 'text',
      messageId: 'r1',
      conversation: CONV,
      sender: USER,
      isGroup: false,
      timestamp: '2026-09-26T10:00:00.000Z',
      text: ' /Deny ',
      addressed: 'dm',
      appMentions: [],
    });
    await flush();
    expect(setupConfig.onAction).toHaveBeenCalledWith('q-1', 'Deny', SENDER_ID, expect.anything());
    expect(setupConfig.onInbound).not.toHaveBeenCalled();
    await adapter.teardown();
  });

  it('accepts an addressed /option reply in a group, wherever the mention sits', async () => {
    const { adapter, child } = await started();
    await adapter.deliver(PLATFORM_ID, null, { kind: 'chat', content: question });
    child.event({
      kind: 'text',
      messageId: 'r2',
      conversation: CONV,
      sender: USER,
      isGroup: true,
      timestamp: '2026-09-26T10:00:00.000Z',
      text: '/approve @Bot',
      addressed: 'mention',
      appMentions: [{ offset: 9, length: 4 }],
    });
    await flush();
    expect(setupConfig.onAction).toHaveBeenCalledWith('q-1', 'yes', SENDER_ID, expect.anything());
    expect(setupConfig.onInbound).not.toHaveBeenCalled();
    await adapter.teardown();
  });

  it('falls back to a text question if buttons fail', async () => {
    const { adapter, child } = await started((message, c) => {
      if (message.type === 'init') c.reply({ type: 'ready', appId: APP });
      if (message.type === 'shutdown') c.exit(0);
      if (message.type === 'call') {
        const ok = message.op !== 'sendButtons';
        c.reply(
          ok
            ? { type: 'result', id: message.id, ok, value: 'txt' }
            : { type: 'result', id: message.id, ok, error: 'no' },
        );
      }
    });
    expect(await adapter.deliver(PLATFORM_ID, null, { kind: 'chat', content: question })).toBe('txt');
    expect(child.calls('sendText')).toHaveLength(1);
    await adapter.teardown();
  });
});

describe('optional capabilities', () => {
  it('opens a DM for a user handle and returns its platform id', async () => {
    const { adapter, child } = await started();
    expect(await adapter.openDM(SENDER_ID)).toBe(PLATFORM_ID);
    expect(child.calls('openDM')[0]).toMatchObject({ user: USER });
    await expect(adapter.openDM('slack:U123')).rejects.toThrow();
    await adapter.teardown();
  });

  it('resolves conversation metadata', async () => {
    const { adapter } = await started();
    expect(await adapter.resolveConversation(PLATFORM_ID)).toEqual({ type: 'channel', name: 'Team' });
    await adapter.teardown();
  });
});
