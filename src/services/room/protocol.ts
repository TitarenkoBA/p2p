/**
 * Messages exchanged over the data channels of a room. Version 1 was the 1:1 call: chat as plain
 * strings and no handshake. Anything a peer sends is untrusted, so every message is validated here.
 */
export const PROTOCOL_VERSION = 2;
export const MAX_PARTICIPANTS = 4;
export const MAX_NAME_LENGTH = 32;
export const MAX_CHAT_LENGTH = 4000;

/** What a participant is currently sending. WebRTC itself cannot tell a disabled camera from a dark room. */
export interface PeerMediaState {
  mic: boolean;
  cam: boolean;
  screen: boolean;
}

export const MEDIA_OFF: PeerMediaState = { mic: false, cam: false, screen: false };

export interface MemberInfo {
  id: string;
  name: string;
}

/** Sent as the data connection's metadata, so it is known before the channel opens. */
export interface ConnectMetadata {
  v: number;
  /** The name the joiner asked for; the host fills in a default. Only read by the host. */
  name?: string;
  /** The room the connection belongs to, i.e. the host's ID. */
  room: string;
}

export type RoomMessage =
  | { type: 'welcome'; you: string; host: string; members: MemberInfo[] }
  | { type: 'peer-joined'; id: string; name: string }
  | { type: 'peer-left'; id: string }
  | { type: 'room-full' }
  | { type: 'version-mismatch' }
  | { type: 'chat'; text: string }
  | ({ type: 'media-state' } & PeerMediaState);

/** Tells a version 1 client, which shows strings as chat, why it is being turned away. */
export const OUTDATED_CLIENT_TEXT = 'This room needs the latest version of the app. Reload the page and join again.';

/** The IDs PeerJS accepts. */
const ID_PATTERN = /^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/;
const MAX_ID_LENGTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPeerId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_ID_LENGTH && ID_PATTERN.test(value);
}

/** Trims a display name and strips control characters. Empty means "use the default". */
export function cleanName(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME_LENGTH).trim();
}

export function readMetadata(value: unknown): ConnectMetadata | null {
  if (!isRecord(value) || typeof value['v'] !== 'number' || !isPeerId(value['room'])) {
    return null;
  }
  return { v: value['v'], name: cleanName(value['name']), room: value['room'] };
}

function readMember(value: unknown): MemberInfo | null {
  if (!isRecord(value) || !isPeerId(value['id'])) {
    return null;
  }
  const name = cleanName(value['name']);
  return name ? { id: value['id'], name } : null;
}

/** Returns the message if it is well formed, null otherwise. */
export function parseMessage(data: unknown): RoomMessage | null {
  if (!isRecord(data)) {
    return null;
  }

  switch (data['type']) {
    case 'welcome': {
      const you = cleanName(data['you']);
      const host = cleanName(data['host']);
      const raw = data['members'];
      if (!you || !host || !Array.isArray(raw) || raw.length >= MAX_PARTICIPANTS) {
        return null;
      }
      const members = raw.map(readMember);
      return members.every((member) => member !== null)
        ? { type: 'welcome', you, host, members: members as MemberInfo[] }
        : null;
    }
    case 'peer-joined': {
      const member = readMember(data);
      return member ? { type: 'peer-joined', ...member } : null;
    }
    case 'peer-left':
      return isPeerId(data['id']) ? { type: 'peer-left', id: data['id'] } : null;
    case 'room-full':
    case 'version-mismatch':
      return { type: data['type'] };
    case 'chat': {
      const text = data['text'];
      return typeof text === 'string' && text.trim() && text.length <= MAX_CHAT_LENGTH ? { type: 'chat', text } : null;
    }
    case 'media-state':
      return { type: 'media-state', mic: data['mic'] === true, cam: data['cam'] === true, screen: data['screen'] === true };
    default:
      return null;
  }
}
