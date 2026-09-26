/**
 * Wire channel — shared protocol between the host adapter (wire.ts) and the
 * SDK worker process (wire-worker.ts).
 *
 * Import-safe and dependency-free: no Wire SDK, no NanoClaw host modules, so
 * both sides (and their tests) can load it anywhere.
 *
 * Messages travel over Node's fork IPC channel with `serialization: 'advanced'`
 * (structured clone), so Uint8Array payloads cross without base64.
 */

/** A Wire qualified id: a local UUID plus the backend domain (federation). */
export interface QualifiedIdLike {
  id: string;
  domain: string;
}

// ── Qualified ids ──────────────────────────────────────────────────────────

const QUALIFIED_KEY = /^([^@\s:/]+)@([^@\s:/]+)$/;

/**
 * `id@domain`, lowercased — the form used for NanoClaw platform ids and user
 * handles. Matches the SDK's QualifiedId.toKey apart from case, and passes
 * NanoClaw's namespacedPlatformId untouched (it contains '@').
 */
export function qualifiedKey(value: QualifiedIdLike): string {
  return `${value.id}@${value.domain}`.toLowerCase();
}

/** Parse `id@domain` (optionally prefixed `wire:`); null when malformed. */
export function parseQualifiedKey(key: string): QualifiedIdLike | null {
  const trimmed = key.trim().replace(/^wire:/i, '');
  const match = QUALIFIED_KEY.exec(trimmed);
  return match ? { id: match[1].toLowerCase(), domain: match[2].toLowerCase() } : null;
}

export function sameQualifiedId(a: QualifiedIdLike, b: QualifiedIdLike): boolean {
  return qualifiedKey(a) === qualifiedKey(b);
}

// ── Credentials ────────────────────────────────────────────────────────────

const HEX_KEY = /^[0-9a-fA-F]{64}$/;

/** True when `raw` is exactly 64 hex characters (the 32-byte crypto storage key). */
export function isValidCryptoKeyHex(raw: string): boolean {
  return HEX_KEY.test(raw.trim());
}

/**
 * Decode the 64-hex-char crypto storage key into 32 bytes. Checked with a
 * regex first because Buffer.from(…, 'hex') silently drops invalid characters
 * and would yield a shorter or different key.
 */
export function decodeCryptoKey(raw: string): Uint8Array {
  if (!isValidCryptoKeyHex(raw)) {
    throw new Error('WIRE_CRYPTO_KEY must be exactly 64 hex characters (32 bytes)');
  }
  return new Uint8Array(Buffer.from(raw.trim(), 'hex'));
}

// ── Log hygiene ────────────────────────────────────────────────────────────

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID = new RegExp(`\\b${UUID_SOURCE}\\b`, 'gi');
const UUID_LOCAL_PART = new RegExp(`^${UUID_SOURCE}@`, 'i');
const EMAIL = /\b[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}\b/gi;
const BEARER = /\b(Bearer|access_token=|zuid=)\s*[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * Mask emails, tokens and Wire ids (keeping a 4-char prefix for correlation).
 * NanoClaw's logger does not redact, so every Wire log line and error message
 * passes through here first.
 */
export function redact(text: string): string {
  return (
    text
      .replace(BEARER, (_m, prefix: string) => `${prefix}<redacted>`)
      // A uuid local part is a Wire qualified id, handled by the uuid pass.
      .replace(EMAIL, (match) => (UUID_LOCAL_PART.test(match) ? match : '<email>'))
      .replace(UUID, (id) => `${id.slice(0, 4)}…`)
  );
}

/** Redacted, single-line description of an unknown error. */
export function describeError(err: unknown): string {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return redact(message).replace(/\s+/g, ' ').trim();
}

// ── Failure classification ─────────────────────────────────────────────────

/**
 * Why the worker could not start or stopped.
 *  permanent (the supervisor stops respawning; operator action needed):
 *   - config:   bad host/key/params
 *   - auth:     token rejected
 *   - state:    SDK storage or CoreCrypto unusable with this key
 *   - platform: the SDK's native library cannot load on this host
 *  transient (respawn with backoff):
 *   - network, locked (another worker still owns the state dir), gave-up
 *     (SDK stopped reconnecting), unknown
 */
export type WorkerFailureCode = 'config' | 'auth' | 'state' | 'platform' | 'network' | 'locked' | 'gave-up' | 'unknown';

export const PERMANENT_FAILURES: ReadonlySet<WorkerFailureCode> = new Set(['config', 'auth', 'state', 'platform']);

/** Exit code a worker uses for a transient failure; anything else non-zero is treated the same. */
export const EXIT_TRANSIENT = 75;
/** Exit code a worker uses after reporting a permanent failure. */
export const EXIT_PERMANENT = 78;

// ── Host → worker ──────────────────────────────────────────────────────────

export interface AttachmentPolicy {
  /** Download cap in bytes (declared and actual size). Files are only accepted in 1:1 conversations. */
  maxBytes: number;
}

export interface InitMessage {
  type: 'init';
  apiHost: string;
  apiToken: string;
  cryptoKeyHex: string;
  attachments: AttachmentPolicy;
}

export interface ShutdownMessage {
  type: 'shutdown';
}

export interface ButtonSpec {
  id: string;
  text: string;
}

export type WorkerOp =
  | { op: 'sendText'; conversation: QualifiedIdLike; text: string }
  | { op: 'sendAsset'; conversation: QualifiedIdLike; name: string; mimeType: string; data: Uint8Array }
  | { op: 'editText'; conversation: QualifiedIdLike; messageId: string; text: string }
  | { op: 'react'; conversation: QualifiedIdLike; messageId: string; emoji: string }
  | { op: 'sendButtons'; conversation: QualifiedIdLike; text: string; buttons: ButtonSpec[] }
  | { op: 'confirmButton'; conversation: QualifiedIdLike; messageId: string; buttonId: string | null }
  | { op: 'openDM'; user: QualifiedIdLike }
  | { op: 'conversationInfo'; conversation: QualifiedIdLike };

/** Result type per op (what `call` resolves to). */
export interface WorkerOpResults {
  sendText: string;
  sendAsset: string;
  editText: string;
  react: string;
  sendButtons: string;
  confirmButton: string;
  openDM: QualifiedIdLike;
  conversationInfo: ConversationInfoResult | null;
}

export type CallMessage = { type: 'call'; id: number } & WorkerOp;

export type HostToWorker = InitMessage | ShutdownMessage | CallMessage;

// ── Worker → host ──────────────────────────────────────────────────────────

export interface MentionSpan {
  offset: number;
  length: number;
}

export interface ConversationInfoResult {
  kind: 'direct' | 'group';
  name: string | null;
}

interface InboundBase {
  messageId: string;
  conversation: QualifiedIdLike;
  sender: QualifiedIdLike;
  senderName?: string;
  isGroup: boolean;
  timestamp: string;
}

/**
 * Why a message counts as addressed to the app. The worker forwards nothing
 * else: in groups, plain chatter is discarded before it leaves the worker.
 */
export type Addressed = 'dm' | 'mention' | 'reply';

export interface InboundText extends InboundBase {
  kind: 'text';
  text: string;
  addressed: Addressed;
  /** Spans of `text` that @mention this app. */
  appMentions: MentionSpan[];
  quotedMessageId?: string;
}

export type AssetSkipReason = 'too-large' | 'no-remote-data' | 'download-failed';

/** Only ever from a 1:1 conversation. */
export interface InboundAsset extends InboundBase {
  kind: 'asset';
  name: string | null;
  mimeType: string;
  size: number;
  /** Present when downloaded under the attachment policy. */
  data?: Uint8Array;
  skipped?: AssetSkipReason;
}

export interface InboundButton {
  kind: 'button';
  conversation: QualifiedIdLike;
  sender: QualifiedIdLike;
  isGroup: boolean;
  referenceMessageId: string;
  buttonId: string;
}

export interface ConversationJoined {
  kind: 'joined';
  conversation: QualifiedIdLike;
  name: string | null;
  isGroup: boolean;
}

export interface ConversationRemoved {
  kind: 'removed';
  conversation: QualifiedIdLike;
}

export type WorkerEvent = InboundText | InboundAsset | InboundButton | ConversationJoined | ConversationRemoved;

export type WorkerToHost =
  | { type: 'ready'; appId: QualifiedIdLike }
  | { type: 'failed'; code: WorkerFailureCode; message: string }
  | { type: 'connection'; connected: boolean }
  | { type: 'event'; event: WorkerEvent }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: string }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string };
