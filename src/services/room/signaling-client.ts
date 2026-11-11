import { signal } from '@angular/core';
import Peer, { DataConnection, MediaConnection, PeerOptions } from 'peerjs';
import { environment } from '../../environments/environment';

const SIGNALING_TIMEOUT_MS = 15000;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;

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

export type PeerError = Error & { type?: string };

export const signalingServer =
  environment.peerjs.secure && environment.peerjs.port === 443
    ? environment.peerjs.host
    : `${environment.peerjs.host}:${environment.peerjs.port}`;

export function describeError(err: PeerError): string {
  return (err.type && ERROR_MESSAGES[err.type]) || err.message || 'Unknown error';
}

/** PeerJS reports a missing peer with its ID only in the message text. */
export function unavailablePeerId(err: PeerError): string | null {
  return err.type === 'peer-unavailable' ? (/peer (.+)$/.exec(err.message)?.[1] ?? null) : null;
}

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

export interface SignalingHandlers {
  connection(conn: DataConnection): void;
  call(call: MediaConnection): void;
  /** An error after the peer opened. Errors before that reject `open()` instead. */
  error(err: PeerError, isSignalingOnly: boolean): void;
  /** The peer was closed for good, e.g. the server dropped the ID. */
  closed(): void;
}

/** One PeerJS peer: opening it, keeping the signaling socket alive and tearing it down. */
export class SignalingClient {
  private peer?: Peer;
  private abortOpen?: (err: Error) => void;
  private reconnectTimer?: number;
  private reconnectAttempts = 0;

  /** True while the socket is down. An open call does not need it, only new connections do. */
  readonly lost = signal(false);

  constructor(private readonly handlers: SignalingHandlers) {}

  get id(): string | undefined {
    return this.peer?.open ? this.peer.id : undefined;
  }

  /** Resolves with the ID the server confirmed. Rejects with a readable error. */
  open(id?: string): Promise<string> {
    const options = buildPeerOptions();
    const peer = id ? new Peer(id, options) : new Peer(options);
    this.peer = peer;

    return new Promise<string>((resolve, reject) => {
      let opened = false;
      const timer = window.setTimeout(() => fail(new Error('Timed out waiting for the signaling server.')), SIGNALING_TIMEOUT_MS);
      const fail = (err: Error): void => {
        if (!opened) {
          opened = true;
          window.clearTimeout(timer);
          this.destroy();
          reject(err);
        }
      };
      this.abortOpen = fail;

      // Every handler checks `this.peer`: destroy() clears it first, because peer.destroy()
      // emits 'disconnected' and reconnecting from there would leave a live socket holding the ID.
      peer.on('open', (openId) => {
        if (this.peer !== peer) {
          return;
        }
        this.reconnectAttempts = 0;
        this.lost.set(false);
        if (!opened) {
          opened = true;
          window.clearTimeout(timer);
          resolve(openId);
        }
      });

      peer.on('connection', (conn) => {
        if (this.peer === peer) {
          this.handlers.connection(conn);
        }
      });

      peer.on('call', (call) => {
        if (this.peer === peer) {
          this.handlers.call(call);
        }
      });

      peer.on('disconnected', () => {
        if (this.peer === peer) {
          this.scheduleReconnect(peer);
        }
      });

      peer.on('close', () => {
        if (this.peer !== peer) {
          return;
        }
        if (!opened) {
          fail(new Error('The connection to the signaling server was closed.'));
          return;
        }
        this.destroy();
        this.handlers.closed();
      });

      peer.on('error', (err: PeerError) => {
        if (this.peer !== peer) {
          return;
        }
        if (!opened) {
          fail(new Error(describeError(err)));
          return;
        }
        this.handlers.error(err, !!err.type && SIGNALING_ERRORS.has(err.type));
      });
    });
  }

  connect(peerId: string, metadata: unknown): DataConnection | undefined {
    return this.peer?.connect(peerId, { reliable: true, metadata });
  }

  call(peerId: string, stream: MediaStream): MediaConnection | undefined {
    // Offer to receive both kinds even without local tracks: otherwise the SDP has no
    // audio/video sections and the other side has no way to send its media back.
    // PeerJS forwards `constraints` to createOffer() but does not declare it in CallOption.
    const options = { constraints: { offerToReceiveAudio: true, offerToReceiveVideo: true } };
    return this.peer?.call(peerId, stream, options as object);
  }

  /** Also rejects an `open()` still in progress. */
  destroy(): void {
    const { peer, abortOpen } = this;
    this.peer = undefined;
    this.abortOpen = undefined;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectAttempts = 0;
    this.lost.set(false);
    peer?.destroy();
    abortOpen?.(new Error('Cancelled'));
  }

  private scheduleReconnect(peer: Peer): void {
    this.lost.set(true);
    window.clearTimeout(this.reconnectTimer);
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_DELAY_MS);
    this.reconnectAttempts += 1;
    this.reconnectTimer = window.setTimeout(() => {
      if (this.peer === peer && peer.disconnected && !peer.destroyed) {
        peer.reconnect();
      }
    }, delay);
  }
}
