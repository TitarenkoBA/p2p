import { Injectable, OnDestroy, computed, signal } from '@angular/core';
import { DataConnection, MediaConnection } from 'peerjs';
import { Subject } from 'rxjs';
import { LinkHandlers, PeerLink } from './peer-link';
import {
  ConnectMetadata,
  MAX_PARTICIPANTS,
  MEDIA_OFF,
  OUTDATED_CLIENT_TEXT,
  PROTOCOL_VERSION,
  PeerMediaState,
  RoomMessage,
  cleanName,
  parseMessage,
  readMetadata
} from './protocol';
import { PeerError, SignalingClient, describeError, signalingServer, unavailablePeerId } from './signaling-client';

const WELCOME_TIMEOUT_MS = 20000;
/** How long a guest waits for the host to vouch for someone who connected to it directly. */
const ADMISSION_TIMEOUT_MS = 10000;
const REFUSE_CLOSE_DELAY_MS = 1000;
const DEFAULT_HOST_NAME = 'Host';

/** Video bitrate per connection: everyone sends their camera once per other participant. */
const VIDEO_BITRATE_BY_LINKS: Record<number, number | undefined> = { 2: 900_000, 3: 600_000 };

export type PeerRole = 'host' | 'guest' | null;
export type ConnectionState = 'idle' | 'opening' | 'waiting' | 'connecting' | 'connected';
type Phase = 'idle' | 'opening' | 'joining' | 'open';

export type RoomEvent =
  /** Someone else came in. */
  | { type: 'joined'; name: string }
  | { type: 'left'; name: string }
  /** This side got into the room; `names` are the people already there. */
  | { type: 'entered'; names: string[] }
  | { type: 'room-closed' }
  | { type: 'message'; from: string; text: string }
  | { type: 'error'; message: string };

/**
 * A room of up to four people, all connected to each other. The host admits guests and tells
 * everyone who is in; guests only accept direct connections from people the host announced.
 */
@Injectable({ providedIn: 'root' })
export class RoomService implements OnDestroy {
  private readonly client = signal<SignalingClient | undefined>(undefined);
  private readonly phase = signal<Phase>('idle');
  private readonly linkMap = new Map<string, PeerLink>();
  /** Guests the host announced who have not connected to this side yet. */
  private readonly expected = new Map<string, string>();
  private outgoing?: MediaStream;
  private blankVideoTrack?: MediaStreamTrack;
  private pending?: { resolve: () => void; reject: (err: Error) => void; timer: number };
  private lastGuestNumber = 1;
  private mediaState: PeerMediaState = MEDIA_OFF;

  private readonly eventsSubject = new Subject<RoomEvent>();
  readonly events$ = this.eventsSubject.asObservable();

  readonly role = signal<PeerRole>(null);
  readonly myPeerId = signal<string | null>(null);
  readonly roomId = signal<string | null>(null);
  readonly myName = signal('');
  /** The other people in the room, in the order they appeared. */
  readonly participants = signal<PeerLink[]>([]);
  readonly signalingLost = computed(() => this.client()?.lost() ?? false);
  readonly signalingServer = signalingServer;
  readonly capacity = MAX_PARTICIPANTS;

  readonly state = computed<ConnectionState>(() => {
    switch (this.phase()) {
      case 'idle':
        return 'idle';
      case 'opening':
        return 'opening';
      case 'joining':
        return 'connecting';
    }
    if (this.role() === 'guest') {
      return 'connected';
    }
    const statuses = this.participants().map((link) => link.status());
    if (statuses.includes('connected')) {
      return 'connected';
    }
    return statuses.includes('connecting') ? 'connecting' : 'waiting';
  });

  private readonly linkHandlers: LinkHandlers = {
    open: (link) => {
      if (link.admitted && this.linkMap.get(link.id) === link) {
        this.greet(link);
      }
    },
    data: (link, data) => {
      if (this.linkMap.get(link.id) !== link) {
        return;
      }
      if (link.admitted) {
        this.handleData(link, data);
      } else {
        link.held.push(data);
      }
    },
    closed: (link) => this.handleLinkClosed(link),
    failed: (link) => this.handleLinkFailed(link),
    stream: () => this.applyBitrate(),
    error: (link, message) => {
      if (this.linkMap.get(link.id) === link) {
        this.eventsSubject.next({ type: 'error', message });
      }
    }
  };

  /** Closes the channels right away so the others do not wait for an ICE timeout. */
  private readonly onPageHide = (): void => this.teardown();

  constructor() {
    window.addEventListener('pagehide', this.onPageHide);
  }

  async createRoom(localStream: MediaStream, name: string, roomId?: string): Promise<string> {
    const client = this.begin('host', localStream, cleanName(name) || DEFAULT_HOST_NAME);
    try {
      const id = await client.open(roomId?.trim() || undefined);
      this.assertCurrent(client);
      this.myPeerId.set(id);
      this.roomId.set(id);
      this.phase.set('open');
      return id;
    } catch (error) {
      this.abandon(client);
      throw error;
    }
  }

  /** Resolves once the host has let this side in, not just when signaling is up. */
  async joinRoom(roomId: string, localStream: MediaStream, name: string): Promise<void> {
    const hostId = roomId.trim();
    if (!hostId) {
      throw new Error('Enter a room ID to connect.');
    }

    const client = this.begin('guest', localStream, cleanName(name));
    try {
      const id = await client.open();
      this.assertCurrent(client);
      this.myPeerId.set(id);
      this.roomId.set(hostId);
      this.phase.set('joining');

      const welcomed = this.waitFor(WELCOME_TIMEOUT_MS, 'The host did not respond. Check the room ID and try again.');
      const host = this.addLink(hostId, true, DEFAULT_HOST_NAME);
      this.dial(host, { v: PROTOCOL_VERSION, name: this.myName(), room: hostId });
      await welcomed;
    } catch (error) {
      this.abandon(client);
      throw error;
    }
  }

  /** False if nobody received it. */
  sendMessage(text: string): boolean {
    return this.broadcast({ type: 'chat', text }) > 0;
  }

  sendMediaState(state: PeerMediaState): void {
    this.mediaState = state;
    this.broadcast({ type: 'media-state', ...state });
  }

  /** Swaps what is being sent to everyone without renegotiating. No video track means the blank one. */
  setOutgoingTrack(kind: MediaStreamTrack['kind'], track: MediaStreamTrack | null): void {
    const outgoing = this.outgoing;
    if (!outgoing) {
      return;
    }

    const next = track ?? (kind === 'video' ? this.getBlankVideoTrack() : undefined) ?? null;
    outgoing.getTracks().filter((item) => item.kind === kind).forEach((item) => outgoing.removeTrack(item));
    if (next) {
      outgoing.addTrack(next);
    }

    for (const link of this.linkMap.values()) {
      const sender = link.peerConnection
        ?.getTransceivers()
        .find((transceiver) => transceiver.receiver.track.kind === kind)?.sender;
      sender?.replaceTrack(next).catch((err: Error) => {
        this.eventsSubject.next({ type: 'error', message: `Media error: ${err.message}` });
      });
    }
  }

  disconnect(): void {
    this.teardown();
  }

  ngOnDestroy(): void {
    window.removeEventListener('pagehide', this.onPageHide);
    this.teardown();
    this.blankVideoTrack?.stop();
  }

  private begin(role: Exclude<PeerRole, null>, localStream: MediaStream, name: string): SignalingClient {
    this.teardown();
    this.outgoing = this.buildOutgoingStream(localStream);
    this.role.set(role);
    this.myName.set(name);
    this.phase.set('opening');

    const client: SignalingClient = new SignalingClient({
      connection: (conn) => this.client() === client && this.acceptConnection(conn),
      call: (call) => this.client() === client && this.acceptCall(call),
      error: (err, isSignalingOnly) => this.client() === client && this.handleSignalingError(err, isSignalingOnly),
      closed: () => {
        if (this.client() === client) {
          this.teardown();
          this.eventsSubject.next({ type: 'error', message: 'The connection to the signaling server was closed.' });
        }
      }
    });
    this.client.set(client);
    return client;
  }

  private assertCurrent(client: SignalingClient): void {
    if (this.client() !== client) {
      throw new Error('Cancelled');
    }
  }

  private abandon(client: SignalingClient): void {
    if (this.client() === client) {
      this.teardown();
    }
  }

  /**
   * PeerJS cannot renegotiate a call, so a video sender has to exist from the start or a side
   * without a camera could never share its screen. A blank track reserves that sender.
   */
  private buildOutgoingStream(localStream: MediaStream): MediaStream {
    const outgoing = new MediaStream(localStream.getTracks());
    if (outgoing.getVideoTracks().length === 0) {
      const blank = this.getBlankVideoTrack();
      if (blank) {
        outgoing.addTrack(blank);
      }
    }
    return outgoing;
  }

  private getBlankVideoTrack(): MediaStreamTrack | undefined {
    if (!this.blankVideoTrack) {
      const canvas = document.createElement('canvas');
      canvas.width = 16;
      canvas.height = 9;
      canvas.getContext('2d')?.fillRect(0, 0, canvas.width, canvas.height);
      this.blankVideoTrack = canvas.captureStream?.(1).getVideoTracks()[0];
    }
    return this.blankVideoTrack;
  }

  private addLink(id: string, isHost: boolean, name?: string): PeerLink {
    const link = new PeerLink(id, isHost, this.linkHandlers);
    if (name !== undefined) {
      link.admitted = true;
      link.name.set(name);
    }
    this.linkMap.set(id, link);
    this.syncParticipants();
    return link;
  }

  private dial(link: PeerLink, metadata: ConnectMetadata): void {
    const client = this.client();
    const conn = client?.connect(link.id, metadata);
    const call = this.outgoing && client?.call(link.id, this.outgoing);
    if (conn) {
      link.attachData(conn);
    }
    if (call) {
      link.attachCall(call);
    }
  }

  private acceptConnection(conn: DataConnection): void {
    const meta = readMetadata(conn.metadata);
    if (this.role() === 'host') {
      this.acceptGuest(conn, meta);
      return;
    }

    // A guest only takes direct connections from members of the same room.
    if (this.phase() !== 'open' || meta?.v !== PROTOCOL_VERSION || meta.room !== this.roomId() || this.linkMap.has(conn.peer)) {
      conn.close();
      return;
    }

    const name = this.expected.get(conn.peer);
    const link = this.addLink(conn.peer, false, name);
    link.attachData(conn);
    if (name === undefined) {
      // The host's announcement may still be on its way.
      window.setTimeout(() => {
        if (!link.admitted && this.linkMap.get(link.id) === link) {
          link.close();
        }
      }, ADMISSION_TIMEOUT_MS);
    } else {
      this.expected.delete(conn.peer);
    }
  }

  private acceptGuest(conn: DataConnection, meta: ConnectMetadata | null): void {
    if (this.phase() !== 'open' || this.linkMap.has(conn.peer)) {
      conn.close();
      return;
    }
    if (!meta) {
      // The 1:1 version of the app sends no metadata and shows strings as chat.
      this.refuse(conn, OUTDATED_CLIENT_TEXT);
      return;
    }
    if (meta.v !== PROTOCOL_VERSION || meta.room !== this.myPeerId()) {
      this.refuse(conn, { type: 'version-mismatch' });
      return;
    }
    if (this.linkMap.size >= MAX_PARTICIPANTS - 1) {
      this.refuse(conn, { type: 'room-full' });
      return;
    }

    const link = this.addLink(conn.peer, false, meta.name || `Guest ${++this.lastGuestNumber}`);
    link.attachData(conn);
  }

  private refuse(conn: DataConnection, message: RoomMessage | string): void {
    conn.on('open', () => {
      conn.send(message);
      window.setTimeout(() => conn.close(), REFUSE_CLOSE_DELAY_MS);
    });
  }

  private acceptCall(call: MediaConnection): void {
    const link = this.linkMap.get(call.peer);
    if (!link || !this.outgoing) {
      call.close();
      return;
    }
    if (link.attachCall(call) && link.admitted) {
      link.answer(this.outgoing);
    }
  }

  private admit(link: PeerLink, name: string): void {
    link.admitted = true;
    link.name.set(name);
    if (this.outgoing) {
      link.answer(this.outgoing);
    }
    this.syncParticipants();
    if (link.isOpen) {
      this.greet(link);
    }
    for (const data of link.held.splice(0)) {
      this.handleData(link, data);
    }
  }

  /** Runs once a participant's channel is open and they are known to belong to the room. */
  private greet(link: PeerLink): void {
    if (this.role() === 'host') {
      const others = this.openLinks().filter((other) => other !== link);
      // Announce first, so the others expect the newcomer before it dials them.
      others.forEach((other) => other.send({ type: 'peer-joined', id: link.id, name: link.name() }));
      link.send({
        type: 'welcome',
        you: link.name(),
        host: this.myName(),
        members: others.map((other) => ({ id: other.id, name: other.name() }))
      });
      this.eventsSubject.next({ type: 'joined', name: link.name() });
    }
    link.send({ type: 'media-state', ...this.mediaState });
    this.syncParticipants();
  }

  private handleData(link: PeerLink, data: unknown): void {
    const message = parseMessage(data);
    const fromHost = this.role() === 'guest' && link.isHost;

    if (fromHost && this.phase() === 'joining') {
      this.handleHostReply(link, message);
      return;
    }
    if (!message) {
      return;
    }

    switch (message.type) {
      case 'chat':
        this.eventsSubject.next({ type: 'message', from: link.name(), text: message.text });
        break;
      case 'media-state':
        link.media.set({ mic: message.mic, cam: message.cam, screen: message.screen });
        break;
      case 'peer-joined':
        if (fromHost) {
          this.handlePeerJoined(message.id, message.name);
        }
        break;
      case 'peer-left':
        if (fromHost) {
          this.handlePeerLeft(message.id);
        }
        break;
    }
  }

  /** The first thing the host says decides whether this side is in. */
  private handleHostReply(host: PeerLink, message: RoomMessage | null): void {
    switch (message?.type) {
      case 'welcome': {
        this.myName.set(message.you);
        host.name.set(message.host);
        for (const member of message.members) {
          if (member.id !== this.myPeerId() && !this.linkMap.has(member.id)) {
            this.dial(this.addLink(member.id, false, member.name), { v: PROTOCOL_VERSION, room: host.id });
          }
        }
        this.phase.set('open');
        this.resolvePending();
        this.eventsSubject.next({ type: 'entered', names: [message.host, ...message.members.map((member) => member.name)] });
        break;
      }
      case 'room-full':
        this.rejectPending(new Error(`This room is full: up to ${MAX_PARTICIPANTS} people can join.`));
        break;
      case 'version-mismatch':
        this.rejectPending(new Error('The host uses a different version of the app. Both of you need to reload the page.'));
        break;
      default:
        // The 1:1 version of the app has no handshake and starts with its media state or chat.
        this.rejectPending(new Error('The host uses an older version of the app. Ask them to reload the page.'));
    }
  }

  private handlePeerJoined(id: string, name: string): void {
    if (id === this.myPeerId()) {
      return;
    }
    const link = this.linkMap.get(id);
    if (link && !link.admitted) {
      this.admit(link, name);
    } else if (!link) {
      this.expected.set(id, name);
    }
    this.eventsSubject.next({ type: 'joined', name });
  }

  private handlePeerLeft(id: string): void {
    const name = this.expected.get(id);
    this.expected.delete(id);
    const link = this.linkMap.get(id);
    if (link) {
      link.close();
    } else if (name !== undefined) {
      this.eventsSubject.next({ type: 'left', name });
    }
  }

  private handleLinkClosed(link: PeerLink): void {
    if (this.linkMap.get(link.id) !== link) {
      return;
    }
    this.linkMap.delete(link.id);

    if (this.role() === 'guest' && link.isHost) {
      // The host's channel defines the room.
      if (this.pending) {
        this.rejectPending(new Error('The host closed the connection.'));
        return;
      }
      this.teardown();
      this.eventsSubject.next({ type: 'room-closed' });
      return;
    }

    this.syncParticipants();
    const wasInRoom = this.role() === 'host' ? link.status() === 'connected' : link.admitted;
    if (!wasInRoom) {
      return;
    }
    if (this.role() === 'host') {
      this.broadcast({ type: 'peer-left', id: link.id });
    }
    this.eventsSubject.next({ type: 'left', name: link.name() });
  }

  private handleLinkFailed(link: PeerLink): void {
    if (this.linkMap.get(link.id) !== link) {
      return;
    }
    if (this.role() === 'guest' && link.isHost) {
      this.rejectPending(new Error('The host did not respond. Check the room ID and try again.'));
    } else if (this.role() === 'host' || !link.admitted) {
      link.close();
    }
    // A guest keeps a failed direct link on screen: that person is still in the room.
  }

  private handleSignalingError(err: PeerError, isSignalingOnly: boolean): void {
    const missingId = unavailablePeerId(err);
    if (missingId && missingId !== this.roomId()) {
      // A member who left before this side reached them; the host will confirm it.
      this.linkMap.get(missingId)?.close();
      return;
    }
    const message = describeError(err);
    if (this.rejectPending(new Error(message))) {
      return;
    }
    // Past the initial connect these are reported through `signalingLost` and retried.
    if (!isSignalingOnly) {
      this.eventsSubject.next({ type: 'error', message });
    }
  }

  private openLinks(): PeerLink[] {
    return [...this.linkMap.values()].filter((link) => link.admitted && link.isOpen);
  }

  private broadcast(message: RoomMessage): number {
    return this.openLinks().filter((link) => link.send(message)).length;
  }

  private syncParticipants(): void {
    this.participants.set([...this.linkMap.values()].filter((link) => link.admitted));
    this.applyBitrate();
  }

  /** Every extra participant costs another upload of the camera, so each one gets less. */
  private applyBitrate(): void {
    const links = [...this.linkMap.values()].filter((link) => link.peerConnection);
    const maxBitrate = VIDEO_BITRATE_BY_LINKS[links.length];
    for (const link of links) {
      const sender = link.peerConnection
        ?.getTransceivers()
        .find((transceiver) => transceiver.receiver.track.kind === 'video')?.sender;
      const params = sender?.getParameters();
      if (!sender || !params?.encodings?.length) {
        continue;
      }
      for (const encoding of params.encodings) {
        if (maxBitrate) {
          encoding.maxBitrate = maxBitrate;
        } else {
          delete encoding.maxBitrate;
        }
      }
      sender.setParameters(params).catch((error: unknown) => console.warn('Could not limit the bitrate', error));
    }
  }

  private waitFor(timeoutMs: number, timeoutMessage: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => this.rejectPending(new Error(timeoutMessage)), timeoutMs);
      this.pending = { resolve, reject, timer };
    });
  }

  private resolvePending(): void {
    const pending = this.pending;
    if (pending) {
      window.clearTimeout(pending.timer);
      this.pending = undefined;
      pending.resolve();
    }
  }

  /** Fails the operation in progress and drops the half-open room. False if nothing was pending. */
  private rejectPending(err: Error): boolean {
    const pending = this.pending;
    if (!pending) {
      return false;
    }
    window.clearTimeout(pending.timer);
    this.pending = undefined;
    this.teardown();
    pending.reject(err);
    return true;
  }

  private teardown(): void {
    this.rejectPending(new Error('Cancelled'));

    const links = [...this.linkMap.values()];
    const client = this.client();
    this.linkMap.clear();
    this.expected.clear();
    this.client.set(undefined);
    this.outgoing = undefined;
    this.lastGuestNumber = 1;

    links.forEach((link) => link.close());
    client?.destroy();

    this.participants.set([]);
    this.myPeerId.set(null);
    this.roomId.set(null);
    this.myName.set('');
    this.role.set(null);
    this.phase.set('idle');
  }
}
