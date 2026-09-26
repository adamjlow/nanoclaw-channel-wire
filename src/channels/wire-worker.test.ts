import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as WireSdk from '@wireapp/wire-apps-js-sdk';

import { WireWorker, acquireLock, classifyError, isoTimestamp, setMessageSink } from './wire-worker.js';
import type { InitMessage, QualifiedIdLike, WorkerToHost } from './wire-protocol.js';

const APP = { id: '33333333-3333-4333-8333-333333333333', domain: 'wire.example' };
const USER = { id: '22222222-2222-4222-8222-222222222222', domain: 'wire.example' };
const DM = { id: '11111111-1111-4111-8111-111111111111', domain: 'wire.example' };
const GROUP = { id: '44444444-4444-4444-8444-444444444444', domain: 'wire.example' };

// ── Fake SDK module (only what the worker touches) ─────────────────────────

class QualifiedId {
  constructor(
    readonly id: string,
    readonly domain: string,
  ) {}
}

enum ConversationType {
  GROUP = 0,
  SELF = 1,
  ONE_TO_ONE = 2,
}

function makeSdk() {
  const conversations = [
    { ...DM, name: null, type: ConversationType.ONE_TO_ONE, teamId: null },
    { ...GROUP, name: 'Team', type: ConversationType.GROUP, teamId: null },
  ];
  let sent = 0;
  const manager = {
    getApplicationQualifiedId: () => new QualifiedId(APP.id, APP.domain),
    getAllConversations: vi.fn(async () => conversations),
    getUsers: vi.fn(async (ids: QualifiedIdLike[]) => ids.map(() => ({ name: 'Alice' }))),
    getMembersInConversation: vi.fn(async (c: QualifiedIdLike) =>
      c.id === DM.id ? [{ userId: USER }, { userId: APP }] : [],
    ),
    createOneToOneConversation: vi.fn(
      async () => new QualifiedId('55555555-5555-4555-8555-555555555555', 'wire.example'),
    ),
    downloadAsset: vi.fn(async () => new Uint8Array([1, 2, 3])),
    sendMessage: vi.fn(async (_m: unknown) => `sent-${++sent}`),
    sendAsset: vi.fn(async () => `asset-${++sent}`),
  };
  let handler: WireSdk.WireEventsHandler | undefined;
  const sdk = {
    setBackendConnectionListener: vi.fn(),
    startListening: vi.fn(async () => undefined),
    stopListening: vi.fn(),
    close: vi.fn(async () => undefined),
    getApplicationManager: () => manager,
  };
  const S = {
    QualifiedId,
    ConversationType,
    WireEventsHandler: class {},
    WireMessageType: { COMPOSITE_BUTTON_ACTION_CONFIRMATION: 'composite_button_action_confirmation' },
    WireAppSdk: {
      create: vi.fn(async (_token: string, _host: string, key: Uint8Array, h: WireSdk.WireEventsHandler) => {
        expect(key).toHaveLength(32);
        handler = h;
        return sdk;
      }),
    },
    TextMessage: { create: (p: object) => ({ type: 'text', ...p }) },
    TextEditedMessage: { create: (p: object) => ({ type: 'text-edited', ...p }) },
    Reaction: { create: (p: object) => ({ type: 'reaction', ...p }) },
    CompositeButton: { create: (p: object) => ({ type: 'composite_button', ...p }) },
    CompositeMessage: { create: (p: object) => ({ type: 'composite', ...p }) },
  };
  return { S: S as unknown as typeof WireSdk, sdk, manager, handler: () => handler! };
}

const init: InitMessage = {
  type: 'init',
  apiHost: 'https://nginz.wire.example',
  apiToken: 'token',
  cryptoKeyHex: 'ab'.repeat(32),
  attachments: { maxBytes: 100 },
};

let posted: WorkerToHost[];
const events = () => posted.filter((m) => m.type === 'event').map((m) => (m as { event: unknown }).event);
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function startedWorker(policy = init.attachments) {
  const fake = makeSdk();
  const worker = new WireWorker(fake.S, policy);
  const appId = await worker.start({ ...init, attachments: policy });
  return { ...fake, worker, appId };
}

function textMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'text',
    id: 'msg-1',
    conversationId: new QualifiedId(DM.id, DM.domain),
    sender: new QualifiedId(USER.id, USER.domain),
    // The real SDK delivers the backend event's ISO string despite its Date type.
    timestamp: '2026-09-26T10:00:00.000Z',
    text: 'hello',
    ...overrides,
  } as unknown as WireSdk.TextMessage;
}

beforeEach(() => {
  posted = [];
  setMessageSink((m) => posted.push(m));
});

describe('WireWorker lifecycle', () => {
  it('creates the SDK, listens, and reports the app id', async () => {
    const { sdk, appId } = await startedWorker();
    expect(appId).toEqual(APP);
    expect(sdk.setBackendConnectionListener).toHaveBeenCalled();
    expect(sdk.startListening).toHaveBeenCalled();
  });

  it('forwards backend connection changes', async () => {
    const { sdk, worker } = await startedWorker();
    const listener = sdk.setBackendConnectionListener.mock.calls[0][0] as WireSdk.BackendConnectionListener;
    listener.onDisconnected();
    listener.onConnected();
    expect(posted.filter((m) => m.type === 'connection')).toEqual([
      { type: 'connection', connected: false },
      { type: 'connection', connected: true },
    ]);
    await worker.stop();
  });

  it('stops listening and closes the SDK once', async () => {
    const { sdk, worker } = await startedWorker();
    await worker.stop();
    await worker.stop();
    expect(sdk.stopListening).toHaveBeenCalledTimes(1);
    expect(sdk.close).toHaveBeenCalledTimes(1);
  });
});

describe('WireWorker inbound', () => {
  it('emits DM text with sender name and no app mentions', async () => {
    const { handler, worker } = await startedWorker();
    await handler().onTextMessageReceived(textMessage());
    await flush();
    expect(events()).toEqual([
      {
        kind: 'text',
        messageId: 'msg-1',
        conversation: DM,
        sender: USER,
        senderName: 'Alice',
        isGroup: false,
        timestamp: '2026-09-26T10:00:00.000Z',
        text: 'hello',
        addressed: 'dm',
        appMentions: [],
        quotedMessageId: undefined,
      },
    ]);
    await worker.stop();
  });

  it('keeps only mentions of this app (domain included) in groups', async () => {
    const { handler, worker } = await startedWorker();
    await handler().onTextMessageReceived(
      textMessage({
        conversationId: new QualifiedId(GROUP.id, GROUP.domain),
        mentions: [
          { userId: new QualifiedId(APP.id, APP.domain), offset: 0, length: 4 },
          { userId: new QualifiedId(APP.id, 'other.example'), offset: 5, length: 4 },
          { userId: new QualifiedId(USER.id, USER.domain), offset: 10, length: 6 },
        ],
      }),
    );
    await flush();
    expect(events()[0]).toMatchObject({ isGroup: true, addressed: 'mention', appMentions: [{ offset: 0, length: 4 }] });
    await worker.stop();
  });

  it('discards group chatter at the source: no event, no user lookup', async () => {
    const { handler, manager, worker } = await startedWorker();
    await handler().onTextMessageReceived(
      textMessage({
        conversationId: new QualifiedId(GROUP.id, GROUP.domain),
        text: 'not for the app',
        // Mentions someone else, and quotes a message the app never sent.
        mentions: [{ userId: new QualifiedId(USER.id, USER.domain), offset: 0, length: 6 }],
        quotedMessageId: 'someone-elses',
      }),
    );
    await flush();
    expect(posted).toEqual([]);
    expect(manager.getUsers).not.toHaveBeenCalled();
    await worker.stop();
  });

  it("treats a group reply quoting the app's own message as addressed", async () => {
    const { handler, worker } = await startedWorker();
    const mine = await worker.call({ type: 'call', id: 1, op: 'sendText', conversation: GROUP, text: 'hi all' });
    await handler().onTextMessageReceived(
      textMessage({ conversationId: new QualifiedId(GROUP.id, GROUP.domain), quotedMessageId: mine }),
    );
    await flush();
    expect(events()[0]).toMatchObject({ isGroup: true, addressed: 'reply', quotedMessageId: mine });
    await worker.stop();
  });

  it('discards events the channel does not act on without logging them', async () => {
    const { handler, worker } = await startedWorker();
    const h = handler() as unknown as Record<string, (...args: unknown[]) => Promise<void>>;
    for (const name of [
      'onTextMessageEdited',
      'onPingReceived',
      'onLocationMessageReceived',
      'onMessageDeleted',
      'onMessageDelivered',
      'onMessageReactionReceived',
      'onUserJoinedConversation',
    ]) {
      await h[name]({ id: 'x', conversationId: DM });
    }
    await flush();
    expect(posted).toEqual([]);
    await worker.stop();
  });

  it('drops its own echoes and messages from unknown conversations', async () => {
    const { handler, worker } = await startedWorker();
    await handler().onTextMessageReceived(textMessage({ sender: new QualifiedId(APP.id, APP.domain) }));
    await handler().onTextMessageReceived(textMessage({ conversationId: new QualifiedId('nope', 'wire.example') }));
    await flush();
    expect(events()).toEqual([]);
    await worker.stop();
  });

  it('downloads DM files within the cap and discards group files without downloading', async () => {
    const { handler, manager, worker } = await startedWorker();
    const asset = (conv: QualifiedIdLike, size: number, id: string) =>
      ({
        type: 'asset',
        id,
        conversationId: new QualifiedId(conv.id, conv.domain),
        sender: new QualifiedId(USER.id, USER.domain),
        timestamp: new Date(),
        sizeInBytes: size,
        name: 'f.bin',
        mimeType: 'application/octet-stream',
        remoteData: { assetId: 'x' },
      }) as unknown as WireSdk.AssetMessage;
    await handler().onAssetMessageReceived(asset(DM, 3, 'a1'));
    await handler().onAssetMessageReceived(asset(DM, 500, 'a2'));
    await handler().onAssetMessageReceived(asset(GROUP, 3, 'a3'));
    await flush();
    // Order is only guaranteed within a conversation, so look events up by id.
    const byId = (id: string) => (events() as Array<Record<string, unknown>>).find((e) => e.messageId === id);
    const [small, big, group] = [byId('a1'), byId('a2'), byId('a3')];
    expect(small).toMatchObject({ messageId: 'a1', data: new Uint8Array([1, 2, 3]) });
    expect(big).toMatchObject({ messageId: 'a2', skipped: 'too-large' });
    expect(group).toBeUndefined();
    expect(manager.downloadAsset).toHaveBeenCalledTimes(1);
    await worker.stop();
  });

  it('keeps per-conversation order even when handling is slow', async () => {
    const { handler, manager, worker } = await startedWorker();
    let release!: () => void;
    manager.getUsers.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve([{ name: 'Alice' }] as never))),
    );
    await handler().onTextMessageReceived(textMessage({ id: 'first' }));
    await handler().onTextMessageReceived(textMessage({ id: 'second' }));
    await flush();
    expect(events()).toEqual([]);
    release();
    await flush();
    expect(events().map((e) => (e as { messageId: string }).messageId)).toEqual(['first', 'second']);
    await worker.stop();
  });

  it('emits clicks on its own buttons only, and removal from conversations', async () => {
    const { handler, worker } = await startedWorker();
    const q = (await worker.call({
      type: 'call',
      id: 1,
      op: 'sendButtons',
      conversation: DM,
      text: 'Pick',
      buttons: [{ id: 'o0', text: 'A' }],
    })) as string;
    const click = (referenceMessageId: string) =>
      handler().onButtonClicked({
        type: 'composite_button_action',
        id: 'b',
        conversationId: new QualifiedId(DM.id, DM.domain),
        sender: new QualifiedId(USER.id, USER.domain),
        referenceMessageId,
        buttonId: 'o1',
      } as unknown as WireSdk.CompositeButtonAction);
    await click('not-ours');
    await click(q);
    await handler().onUserLeftConversation(new QualifiedId(GROUP.id, GROUP.domain), [
      new QualifiedId(APP.id, APP.domain),
    ] as never);
    await flush();
    // Different conversations, so no ordering guarantee between the two.
    expect(events()).toHaveLength(2);
    expect(events()).toEqual(
      expect.arrayContaining([
        { kind: 'button', conversation: DM, sender: USER, isGroup: false, referenceMessageId: q, buttonId: 'o1' },
        { kind: 'removed', conversation: GROUP },
      ]),
    );
    await worker.stop();
  });
});

describe('WireWorker calls', () => {
  it('sends text and returns the Wire message id', async () => {
    const { manager, worker } = await startedWorker();
    expect(await worker.call({ type: 'call', id: 1, op: 'sendText', conversation: DM, text: 'hi' })).toBe('sent-1');
    expect(manager.sendMessage.mock.calls[0][0]).toMatchObject({ type: 'text', text: 'hi' });
    await worker.stop();
  });

  it('chains edits onto the latest Wire id', async () => {
    const { manager, worker } = await startedWorker();
    await worker.call({ type: 'call', id: 1, op: 'editText', conversation: DM, messageId: 'orig', text: 'v2' });
    await worker.call({ type: 'call', id: 2, op: 'editText', conversation: DM, messageId: 'orig', text: 'v3' });
    const [first, second] = manager.sendMessage.mock.calls.map((c) => c[0] as { replacingMessageId: string });
    expect(first.replacingMessageId).toBe('orig');
    expect(second.replacingMessageId).toBe('sent-1');
    await worker.stop();
  });

  it('builds button messages and confirmations', async () => {
    const { manager, worker } = await startedWorker();
    await worker.call({
      type: 'call',
      id: 1,
      op: 'sendButtons',
      conversation: DM,
      text: 'Approve?',
      buttons: [{ id: 'o0', text: 'Yes' }],
    });
    await worker.call({ type: 'call', id: 2, op: 'confirmButton', conversation: DM, messageId: 'q', buttonId: 'o0' });
    const [composite, confirmation] = manager.sendMessage.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(composite).toMatchObject({ type: 'composite', text: 'Approve?', itemList: [{ id: 'o0', text: 'Yes' }] });
    expect(confirmation).toMatchObject({
      type: 'composite_button_action_confirmation',
      referenceMessageId: 'q',
      buttonId: 'o0',
    });
    await worker.stop();
  });

  it('finds an existing 1:1 conversation, or creates one', async () => {
    const { manager, worker } = await startedWorker();
    expect(await worker.call({ type: 'call', id: 1, op: 'openDM', user: USER })).toEqual(DM);
    const stranger = { id: '66666666-6666-4666-8666-666666666666', domain: 'wire.example' };
    expect(await worker.call({ type: 'call', id: 2, op: 'openDM', user: stranger })).toEqual({
      id: '55555555-5555-4555-8555-555555555555',
      domain: 'wire.example',
    });
    expect(manager.createOneToOneConversation).toHaveBeenCalledTimes(1);
    await worker.stop();
  });

  it('describes conversations from the local store', async () => {
    const { worker } = await startedWorker();
    expect(await worker.call({ type: 'call', id: 1, op: 'conversationInfo', conversation: GROUP })).toEqual({
      kind: 'group',
      name: 'Team',
    });
    await worker.stop();
  });
});

describe('isoTimestamp', () => {
  it('accepts the SDK string, a Date or epoch millis, and never throws', () => {
    expect(isoTimestamp('2026-09-26T10:00:00.000Z')).toBe('2026-09-26T10:00:00.000Z');
    expect(isoTimestamp(new Date('2026-09-26T10:00:00Z'))).toBe('2026-09-26T10:00:00.000Z');
    expect(isoTimestamp(Date.UTC(2026, 8, 26, 10))).toBe('2026-09-26T10:00:00.000Z');
    expect(() => isoTimestamp(undefined)).not.toThrow();
    expect(() => isoTimestamp('garbage')).not.toThrow();
  });
});

describe('classifyError', () => {
  const named = (name: string, message = 'x') => Object.assign(new Error(message), { name });

  it('separates operator-action failures from transient ones', () => {
    expect(classifyError(named('AuthenticationError'))).toBe('auth');
    expect(classifyError(named('InvalidParameterError'))).toBe('config');
    expect(classifyError(named('CryptographicSystemError'))).toBe('state');
    expect(
      classifyError(
        named('UnknownError', 'Stored application QualifiedId a does not match fetched self QualifiedId b'),
      ),
    ).toBe('state');
    expect(classifyError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toBe(
      'network',
    );
    expect(classifyError(named('UnknownError', 'HTTP request failed for /self'))).toBe('network');
    expect(classifyError(new Error('something else'))).toBe('unknown');
  });
});

describe('acquireLock', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-lock-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('takes a free lock and refuses one held by a live process', () => {
    const file = path.join(dir, 'worker.lock');
    fs.writeFileSync(file, String(process.ppid));
    expect(acquireLock(file)).toBe(false);
    fs.rmSync(file);
    expect(acquireLock(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toBe(String(process.pid));
  });

  it('breaks a lock left by a dead process', () => {
    const file = path.join(dir, 'worker.lock');
    fs.writeFileSync(file, '999999999');
    expect(acquireLock(file)).toBe(true);
  });
});
