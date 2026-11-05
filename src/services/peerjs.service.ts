import { Injectable, OnDestroy, signal } from '@angular/core';
import Peer, { CallOption, DataConnection, MediaConnection, PeerOptions } from 'peerjs';
import { Subject } from 'rxjs';
import { environment } from '../environments/environment';

const SIGNALING_TIMEOUT_MS = 15000;
const PEER_CONNECT_TIMEOUT_MS = 20000;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const REFUSE_CLOSE_DELAY_MS = 1000;
const ROOM_FULL_MESSAGE = { type: 'room-full' };
const MEDIA_STATE_MESSAGE_TYPE = 'media-state';
const MEDIA_OFF: PeerMediaState = { mic: false, cam: false, screen: false };

/** Errors that only mean the signaling socket dropped; established peers keep working. */
const SIGNALING_ERRORS = new Set(['network', 'socket-error', 'socket-closed', 'disconnected', 'server-error']);

const ERROR_MESSAGES: Record<string, string> = {
  'peer-unavailable': 'Room not found. Check the ID and make sure the host is online.',
  'unavailable-id': 'This room ID is already taken. Choose another one.',
  'invalid-id': 'Room ID can only contain letters, digits, "-" and "_".',
  'browser-incompatible': 'This browser does not support WebRTC.',
  network: 'Cannot reach the signaling server.',
  'server-error': 'Cannot reach the signaling server.',
  'socket-error': 'Lost connection to the signaling server.',
  'socket-closed': 'Lost connection to the signaling server.',
  webrtc: 'The peer-to-peer connection failed.'
};

function buildPeerOptions(): PeerOptions {
  return {
    host: environment.peerjs.host,
    port: environment.peerjs.port,
    path: environment.peerjs.path,
    secure: environment.peerjs.secure,
    debug: environment.production ? 0 : 1,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        {
          urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'],
          username: 'peerjs',
          credential: 'peerjsp'
        }
      ]
    }
  };
}

function describeError(err: Error & { type?: string }): string {
  return (err.type && ERROR_MESSAGES[err.type]) || err.message || 'Unknown error';
}

/** What a side is currently sending. WebRTC itself cannot tell a disabled camera from a dark room. */
export interface PeerMediaState {
  mic: boolean;
  cam: boolean;
  screen: boolean;
}

export type PeerRole = 'host' | 'guest' | null;
export type ConnectionState = 'idle' | 'opening' | 'waiting' | 'connecting' | 'connected';

export type PeerEvent =
  | { type: 'joined' }
  | { type: 'left'; role: PeerRole }
  | { type: 'room-full' }
  | { type: 'message'; text: string }
  | { type: 'error'; message: string };

@Injectable({ providedIn: 'root' })
export class PeerJsService implements OnDestroy {
  private peer?: Peer;
  private dataConnection?: DataConnection;
  private mediaConnection?: MediaConnection;
  private outgoing?: MediaStream;
  private blankVideoTrack?: MediaStreamTrack;
  private pending?: { resolve: () => void; reject: (err: Error) => void; timer: number };
  private handshakeTimer?: number;
  private reconnectTimer?: number;
  private reconnectAttempts = 0;

  private readonly eventsSubject = new Subject<PeerEvent>();
  readonly events$ = this.eventsSubject.asObservable();

  readonly state = signal<ConnectionState>('idle');
  readonly role = signal<PeerRole>(null);
  readonly myPeerId = signal<string | null>(null);
  readonly remotePeerId = signal<string | null>(null);
  readonly signalingLost = signal(false);
  readonly remoteVideo = signal<MediaStream | undefined>(undefined);
  readonly remoteAudio = signal<MediaStream | undefined>(undefined);
  readonly remoteMedia = signal<PeerMediaState>(MEDIA_OFF);
  readonly signalingServer =
    environment.peerjs.secure && environment.peerjs.port === 443
      ? environment.peerjs.host
      : `${environment.peerjs.host}:${environment.peerjs.port}`;

  /** Closes the channels right away so the other side does not wait for an ICE timeout. */
  private readonly onPageHide = (): void => this.teardown();

  constructor() {
    window.addEventListener('pagehide', this.onPageHide);
  }

  async createRoom(localStream: MediaStream, roomId?: string): Promise<string> {
    const peer = this.openPeer('host', localStream, roomId?.trim() || undefined);
    peer.on('connection', (conn) => this.acceptDataConnection(peer, conn));
    peer.on('call', (call) => this.acceptCall(peer, call));

    await this.waitFor(SIGNALING_TIMEOUT_MS, 'Timed out waiting for the signaling server.');
    this.state.set('waiting');
    return peer.id;
  }

  /** Resolves once the data channel to the host is open, not just when signaling is up. */
  async joinRoom(remotePeerId: string, localStream: MediaStream): Promise<void> {
    const targetId = remotePeerId.trim();
    if (!targetId) {
      throw new Error('Enter a room ID to connect.');
    }

    const peer = this.openPeer('guest', localStream);
    this.remotePeerId.set(targetId);
    await this.waitFor(SIGNALING_TIMEOUT_MS, 'Timed out waiting for the signaling server.');
    this.state.set('connecting');

    const connected = this.waitFor(PEER_CONNECT_TIMEOUT_MS, 'The host did not respond. Check the room ID and try again.');
    const conn = peer.connect(targetId, { reliable: true });
    this.dataConnection = conn;
    this.bindDataConnection(conn);

    // Offer to receive both kinds even without local tracks: otherwise the SDP has no
    // audio/video sections and the host has no way to send its media to this guest.
    // PeerJS forwards `constraints` to createOffer() but does not declare it in CallOption.
    const callOptions = { constraints: { offerToReceiveAudio: true, offerToReceiveVideo: true } } as CallOption;
    const call = peer.call(targetId, this.outgoing as MediaStream, callOptions);
    this.mediaConnection = call;
    this.bindMediaConnection(call);

    await connected;
  }

  sendMessage(text: string): boolean {
    if (!this.dataConnection?.open) {
      return false;
    }
    this.dataConnection.send(text);
    return true;
  }

  sendMediaState(state: PeerMediaState): void {
    if (this.dataConnection?.open) {
      this.dataConnection.send({ type: MEDIA_STATE_MESSAGE_TYPE, ...state });
    }
  }

  /** Swaps what is being sent without renegotiating. No video track means the blank one. */
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

    const sender = this.mediaConnection?.peerConnection
      ?.getTransceivers()
      .find((transceiver) => transceiver.receiver.track.kind === kind)?.sender;
    sender?.replaceTrack(next).catch((err: Error) => {
      this.eventsSubject.next({ type: 'error', message: `Media error: ${err.message}` });
    });
  }

  disconnect(): void {
    this.teardown();
  }

  ngOnDestroy(): void {
    window.removeEventListener('pagehide', this.onPageHide);
    this.teardown();
    this.blankVideoTrack?.stop();
  }

  private openPeer(role: Exclude<PeerRole, null>, localStream: MediaStream, id?: string): Peer {
    this.teardown();
    this.outgoing = this.buildOutgoingStream(localStream);
    this.role.set(role);
    this.state.set('opening');

    const options = buildPeerOptions();
    const peer = id ? new Peer(id, options) : new Peer(options);
    this.peer = peer;

    // Every handler checks `this.peer`: teardown clears it first, because peer.destroy()
    // emits 'disconnected' and reconnecting from there would leave a live socket holding the ID.
    peer.on('open', (openId) => {
      if (this.peer !== peer) {
        return;
      }
      this.myPeerId.set(openId);
      this.reconnectAttempts = 0;
      this.signalingLost.set(false);
      this.resolvePending();
    });

    peer.on('disconnected', () => {
      if (this.peer === peer) {
        this.scheduleReconnect(peer);
      }
    });

    peer.on('close', () => {
      if (this.peer === peer) {
        this.teardown();
        this.eventsSubject.next({ type: 'error', message: 'The connection to the signaling server was closed.' });
      }
    });

    peer.on('error', (err) => {
      if (this.peer === peer) {
        this.handlePeerError(err);
      }
    });

    return peer;
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

  private scheduleReconnect(peer: Peer): void {
    this.signalingLost.set(true);
    window.clearTimeout(this.reconnectTimer);
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_DELAY_MS);
    this.reconnectAttempts += 1;
    this.reconnectTimer = window.setTimeout(() => {
      if (this.peer === peer && peer.disconnected && !peer.destroyed) {
        peer.reconnect();
      }
    }, delay);
  }

  private handlePeerError(err: Error & { type?: string }): void {
    const message = describeError(err);
    if (this.rejectPending(new Error(message))) {
      return;
    }
    // Past the initial connect these are reported through `signalingLost` and retried.
    if (!err.type || !SIGNALING_ERRORS.has(err.type)) {
      this.eventsSubject.next({ type: 'error', message });
    }
  }

  /** A room holds one guest: anyone else is refused instead of taking over the call. */
  private acceptDataConnection(peer: Peer, conn: DataConnection): void {
    if (this.peer !== peer) {
      return;
    }
    if (this.dataConnection) {
      this.refuseDataConnection(conn);
      return;
    }

    this.dataConnection = conn;
    this.state.set('connecting');
    this.bindDataConnection(conn);
    this.handshakeTimer = window.setTimeout(() => {
      if (this.dataConnection === conn && !conn.open) {
        this.resetHostSession();
      }
    }, PEER_CONNECT_TIMEOUT_MS);
  }

  private refuseDataConnection(conn: DataConnection): void {
    conn.on('open', () => {
      conn.send(ROOM_FULL_MESSAGE);
      window.setTimeout(() => conn.close(), REFUSE_CLOSE_DELAY_MS);
    });
  }

  private acceptCall(peer: Peer, call: MediaConnection): void {
    if (this.peer !== peer) {
      return;
    }
    if (this.mediaConnection || call.peer !== this.dataConnection?.peer) {
      call.close();
      return;
    }

    this.mediaConnection = call;
    this.bindMediaConnection(call);
    call.answer(this.outgoing);
  }

  private bindDataConnection(conn: DataConnection): void {
    conn.on('open', () => {
      if (this.dataConnection !== conn) {
        return;
      }
      window.clearTimeout(this.handshakeTimer);
      this.remotePeerId.set(conn.peer);
      this.state.set('connected');
      this.resolvePending();
      this.eventsSubject.next({ type: 'joined' });
    });

    conn.on('data', (data) => {
      if (this.dataConnection !== conn) {
        return;
      }
      if (typeof data === 'string') {
        this.eventsSubject.next({ type: 'message', text: data });
        return;
      }
      const control = data as (Partial<PeerMediaState> & { type?: string }) | null;
      if (control?.type === ROOM_FULL_MESSAGE.type) {
        this.teardown();
        this.eventsSubject.next({ type: 'room-full' });
      } else if (control?.type === MEDIA_STATE_MESSAGE_TYPE) {
        this.remoteMedia.set({ mic: !!control.mic, cam: !!control.cam, screen: !!control.screen });
      }
    });

    conn.on('close', () => {
      if (this.dataConnection === conn) {
        this.handlePeerLeft();
      }
    });

    conn.on('error', (err) => {
      if (this.dataConnection === conn) {
        this.eventsSubject.next({ type: 'error', message: `Data channel error: ${err.message}` });
      }
    });
  }

  private bindMediaConnection(call: MediaConnection): void {
    call.on('stream', (remoteStream) => {
      if (this.mediaConnection === call && remoteStream) {
        this.applyRemoteStream(remoteStream);
      }
    });

    call.on('close', () => {
      if (this.mediaConnection === call) {
        this.mediaConnection = undefined;
        this.clearRemoteStreams();
      }
    });

    call.on('error', (err) => {
      if (this.mediaConnection === call) {
        this.eventsSubject.next({ type: 'error', message: `Media error: ${err.message}` });
      }
    });
  }

  private applyRemoteStream(stream: MediaStream): void {
    const videoTracks = stream.getVideoTracks();
    const audioTracks = stream.getAudioTracks();

    if (videoTracks.length > 0) {
      this.remoteVideo.set(new MediaStream(videoTracks));
    }
    if (audioTracks.length > 0) {
      this.remoteAudio.set(new MediaStream(audioTracks));
    }
  }

  private clearRemoteStreams(): void {
    this.remoteVideo.set(undefined);
    this.remoteAudio.set(undefined);
    this.remoteMedia.set(MEDIA_OFF);
  }

  /** The data channel defines the session: when it closes, the peer is gone. */
  private handlePeerLeft(): void {
    const role = this.role();
    if (role === 'host') {
      this.resetHostSession();
    } else {
      this.teardown();
    }
    this.eventsSubject.next({ type: 'left', role });
  }

  /** The host keeps its room open for the next guest. */
  private resetHostSession(): void {
    const { dataConnection, mediaConnection } = this;
    window.clearTimeout(this.handshakeTimer);
    this.dataConnection = undefined;
    this.mediaConnection = undefined;
    dataConnection?.close();
    mediaConnection?.close();
    this.clearRemoteStreams();
    this.remotePeerId.set(null);
    this.state.set('waiting');
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

  /** Fails the operation in progress and drops its half-open peer. False if nothing was pending. */
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

    const { peer, dataConnection, mediaConnection } = this;
    window.clearTimeout(this.handshakeTimer);
    window.clearTimeout(this.reconnectTimer);
    this.reconnectAttempts = 0;
    this.peer = undefined;
    this.dataConnection = undefined;
    this.mediaConnection = undefined;
    this.outgoing = undefined;

    dataConnection?.close();
    mediaConnection?.close();
    peer?.destroy();

    this.clearRemoteStreams();
    this.myPeerId.set(null);
    this.remotePeerId.set(null);
    this.role.set(null);
    this.signalingLost.set(false);
    this.state.set('idle');
  }
}
