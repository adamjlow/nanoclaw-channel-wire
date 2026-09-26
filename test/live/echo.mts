/**
 * Live echo bot: drives the real WireAdapter → worker → Wire SDK against a
 * real backend, without a NanoClaw host or agents. Commands (DM, or @mention
 * the app in a group):
 *   !ping      → "pong"
 *   !long      → a 20 000-character reply (chunking)
 *   !buttons   → an ask_question; clicking or replying /option echoes the choice
 *   !file      → sends a small text file
 *   !edit      → sends a message, then edits it
 *   !react     → reacts 👍 to your message
 *   !dm        → opens a DM with you (openDM) and writes there
 *   anything   → "echo: <n> chars, group=<bool>, mention=<bool>[, attachments]"
 *
 * Logs only kinds and lengths, never message content.
 * Run via test/live/run.sh.
 */
import { WireAdapter, createWireAdapterFromEnv } from '/app/src/channels/wire.js';
import type { ChannelSetup, InboundMessage } from '/app/src/channels/adapter.js';

const adapter = createWireAdapterFromEnv(process.env, { stateDir: '/state/wire' }) as WireAdapter | null;
if (!adapter) {
  console.error('echo: adapter not created (check WIRE_* env and platform)');
  process.exit(1);
}

type Content = { text?: string; senderId?: string; attachments?: Array<{ name?: string; size?: number; data?: string }> };

const say = (platformId: string, text: string) => adapter.deliver(platformId, null, { kind: 'chat', content: { text } });

async function handle(platformId: string, message: InboundMessage): Promise<void> {
  const content = message.content as Content;
  const text = (content.text ?? '').replace(/@\S+\s*/g, '').trim();
  console.log(`echo: inbound group=${message.isGroup} mention=${message.isMention} len=${text.length}`);
  if (message.isGroup && !message.isMention) return;

  switch (text) {
    case '!ping':
      await say(platformId, 'pong');
      return;
    case '!long':
      await say(platformId, Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}. ${'lorem '.repeat(80)}`).join('\n\n'));
      return;
    case '!buttons':
      await adapter.deliver(platformId, null, {
        kind: 'chat',
        content: {
          type: 'ask_question',
          questionId: `q-${Date.now()}`,
          title: 'Live test',
          question: 'Pick one:',
          options: ['Alpha', { label: 'Bravo two', value: 'bravo' }],
        },
      });
      return;
    case '!file':
      await adapter.deliver(platformId, null, {
        kind: 'chat',
        content: { text: 'here is a file' },
        files: [{ filename: 'hello.txt', data: Buffer.from('hello from nanoclaw-channel-wire\n') }],
      });
      return;
    case '!edit': {
      const id = await say(platformId, 'version 1');
      await new Promise((r) => setTimeout(r, 2000));
      await adapter.deliver(platformId, null, { kind: 'chat', content: { operation: 'edit', messageId: id, text: 'version 2 (edited)' } });
      await new Promise((r) => setTimeout(r, 2000));
      await adapter.deliver(platformId, null, { kind: 'chat', content: { operation: 'edit', messageId: id, text: 'version 3 (edited twice)' } });
      return;
    }
    case '!react':
      await adapter.deliver(platformId, null, {
        kind: 'chat',
        content: { operation: 'reaction', messageId: `${message.id}:ag-test`, emoji: '👍' },
      });
      return;
    case '!dm': {
      if (!content.senderId) return;
      const dm = await adapter.openDM(content.senderId);
      await say(dm, 'hello in our DM (openDM)');
      return;
    }
  }
  const files = content.attachments?.map((a) => `${a.data ? 'downloaded' : 'not downloaded'} ${a.size ?? '?'} bytes`);
  await say(
    platformId,
    `echo: ${text.length} chars, group=${message.isGroup}, mention=${message.isMention}${files ? `, attachments: ${files.join('; ')}` : ''}`,
  );
}

const setup: ChannelSetup = {
  onInbound: (platformId, _threadId, message) => {
    handle(platformId, message).catch((err: unknown) => console.error('echo: handler failed', (err as Error).message));
  },
  onInboundEvent: () => undefined,
  onMetadata: (_platformId, _name, isGroup) => console.log(`echo: joined a conversation (group=${isGroup})`),
  onAction: (questionId, selected, _userId, address) => {
    console.log(`echo: action for ${questionId}`);
    if (address?.platformId) void say(address.platformId, `you chose: ${selected}`);
  },
};

await adapter.setup(setup);
console.log(`echo: setup done, connected=${adapter.isConnected()}`);
setInterval(() => console.log(`echo: connected=${adapter.isConnected()}`), 60_000).unref();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    console.log(`echo: ${signal}, tearing down`);
    void adapter.teardown().then(() => process.exit(0));
  });
}
