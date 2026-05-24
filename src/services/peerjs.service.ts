import { Injectable, NgZone, OnDestroy, signal } from '@angular/core';
import Peer, { DataConnection, MediaConnection, PeerOptions } from 'peerjs';
import { environment } from '../environments/environment';

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

export type PeerRole = 'host' | 'guest' | null;

@Injectable({ providedIn: 'root' })
export class PeerJsService implements OnDestroy {
  private peer?: Peer;
  private dataConnection?: DataConnection;
  private mediaConnection?: MediaConnection;
  private localStream?: MediaStream;
  private remoteVideoStream?: MediaStream;
  private remoteAudioStream?: MediaStream;

  private onRemoteStreamsChange?: (video: MediaStream | undefined, audio: MediaStream | undefined) => void;
  private onDataOpen?: () => void;
  private onDataMessage?: (text: string) => void;
  private onStatusChange?: (status: string) => void;
  private onDisconnected?: () => void;

  readonly myPeerId = signal<string | null>(null);
  readonly role = signal<PeerRole>(null);
  readonly isDataChannelOpen = signal(false);
  readonly signalingServer =
    environment.peerjs.secure && environment.peerjs.port === 443
      ? environment.peerjs.host
      : `${environment.peerjs.host}:${environment.peerjs.port}`;

  constructor(private readonly zone: NgZone) {}

  private createPeer(id?: string): Peer {
    const options = buildPeerOptions();
    return id ? new Peer(id, options) : new Peer(options);
  }

  setCallbacks(callbacks: {
    onRemoteStreamsChange?: (video: MediaStream | undefined, audio: MediaStream | undefined) => void;
    onDataOpen?: () => void;
    onDataMessage?: (text: string) => void;
    onStatusChange?: (status: string) => void;
    onDisconnected?: () => void;
  }): void {
    this.onRemoteStreamsChange = callbacks.onRemoteStreamsChange;
    this.onDataMessage = callbacks.onDataMessage;
    this.onDataOpen = callbacks.onDataOpen;
    this.onStatusChange = callbacks.onStatusChange;
    this.onDisconnected = callbacks.onDisconnected;
  }

  getRemoteStreams(): { video?: MediaStream; audio?: MediaStream } {
    return {
      video: this.remoteVideoStream,
      audio: this.remoteAudioStream
    };
  }

  async createRoom(localStream: MediaStream | undefined, roomId?: string): Promise<string> {
    this.disconnect(false);
    this.localStream = localStream;
    this.role.set('host');
    this.setStatus('Connecting to PeerJS server...');

    const id = roomId?.trim();
    const peer = this.createPeer(id || undefined);
    this.peer = peer;
    this.bindPeerErrors(peer);

    return new Promise((resolve, reject) => {
      let settled = false;

      const fail = (err: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        this.setStatus(`Peer error: ${err.message}`);
        reject(err);
      };

      const timeoutId = window.setTimeout(() => {
        if (!settled) {
          fail(new Error('Timeout waiting for Peer ID'));
        }
      }, 15000);

      peer.on('open', (id) => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timeoutId);
        this.zone.run(() => {
          this.myPeerId.set(id);
          this.setStatus('Room created. Share your Peer ID.');
        });
        resolve(id);
      });

      peer.on('connection', (conn) => {
        this.setupDataConnection(conn);
      });

      peer.on('call', (call) => {
        this.setupMediaConnection(call, true);
      });

      peer.on('disconnected', () => {
        this.setStatus('Disconnected from PeerJS server. Reconnecting...');
        if (!peer.destroyed) {
          peer.reconnect();
        }
      });

      peer.on('close', () => {
        this.zone.run(() => {
          this.myPeerId.set(null);
          this.role.set(null);
        });
        this.setStatus('Peer connection closed');
      });

      peer.once('error', fail);
    });
  }

  async joinRoom(remotePeerId: string, localStream: MediaStream | undefined): Promise<void> {
    const targetId = remotePeerId.trim();
    if (!targetId) {
      throw new Error('Enter peer ID to connect');
    }

    this.disconnect(false);
    this.localStream = localStream;
    this.role.set('guest');
    this.setStatus('Connecting to PeerJS server...');

    const peer = this.createPeer();
    this.peer = peer;
    this.bindPeerErrors(peer);

    return new Promise((resolve, reject) => {
      let settled = false;

      peer.on('open', () => {
        if (settled) {
          return;
        }
        settled = true;
        this.zone.run(() => {
          this.myPeerId.set(peer.id ?? null);
        });
        this.setStatus('Connecting to peer...');

        const conn = peer.connect(targetId, { reliable: true });
        this.setupDataConnection(conn);

        if (this.localStream) {
          const call = peer.call(targetId, this.localStream);
          this.setupMediaConnection(call, false);
        }

        resolve();
      });

      peer.on('disconnected', () => {
        this.setStatus('Disconnected from PeerJS server. Reconnecting...');
        if (!peer.destroyed) {
          peer.reconnect();
        }
      });

      peer.on('close', () => {
        this.zone.run(() => {
          this.myPeerId.set(null);
          this.role.set(null);
        });
      });

      peer.once('error', (err) => {
        if (settled) {
          return;
        }
        settled = true;
        this.setStatus(`Peer error: ${err.message}`);
        reject(err);
      });
    });
  }

  sendMessage(text: string): boolean {
    if (!this.dataConnection?.open) {
      return false;
    }
    this.dataConnection.send(text);
    return true;
  }

  disconnect(notify = true): void {
    this.dataConnection?.close();
    this.mediaConnection?.close();
    this.peer?.destroy();

    this.dataConnection = undefined;
    this.mediaConnection = undefined;
    this.peer = undefined;
    this.localStream = undefined;
    this.remoteVideoStream = undefined;
    this.remoteAudioStream = undefined;

    this.zone.run(() => {
      this.myPeerId.set(null);
      this.role.set(null);
      this.isDataChannelOpen.set(false);
    });

    this.emitRemoteStreams();
    if (notify) {
      this.setStatus('Not connected');
      this.onDisconnected?.();
    }
  }

  ngOnDestroy(): void {
    this.disconnect(false);
  }

  private setupDataConnection(conn: DataConnection): void {
    if (this.dataConnection?.open) {
      return;
    }

    this.dataConnection = conn;

    conn.on('open', () => {
      this.zone.run(() => {
        this.isDataChannelOpen.set(true);
        this.setStatus('Connected');
        this.onDataOpen?.();
      });
    });

    conn.on('data', (data) => {
      this.zone.run(() => {
        this.onDataMessage?.(String(data));
      });
    });

    conn.on('close', () => {
      this.zone.run(() => {
        this.isDataChannelOpen.set(false);
      });
      this.handleConnectionLost();
    });

    conn.on('error', (err) => {
      this.setStatus(`Data channel error: ${err.message}`);
    });
  }

  private setupMediaConnection(call: MediaConnection, isIncoming: boolean): void {
    if (isIncoming && this.localStream) {
      call.answer(this.localStream);
    }

    this.mediaConnection = call;

    call.on('stream', (remoteStream) => {
      this.applyRemoteStream(remoteStream);
    });

    call.on('close', () => {
      this.remoteVideoStream = undefined;
      this.remoteAudioStream = undefined;
      this.emitRemoteStreams();
      this.handleConnectionLost();
    });

    call.on('error', (err) => {
      this.setStatus(`Media error: ${err.message}`);
    });
  }

  private applyRemoteStream(stream: MediaStream): void {
    const videoTracks = stream.getVideoTracks();
    const audioTracks = stream.getAudioTracks();

    if (videoTracks.length > 0) {
      this.remoteVideoStream = new MediaStream(videoTracks);
    }
    if (audioTracks.length > 0) {
      this.remoteAudioStream = new MediaStream(audioTracks);
    }

    this.emitRemoteStreams();
  }

  private emitRemoteStreams(): void {
    this.onRemoteStreamsChange?.(this.remoteVideoStream, this.remoteAudioStream);
  }

  private handleConnectionLost(): void {
    const lost = !this.dataConnection?.open && !this.mediaConnection?.open;
    if (lost) {
      this.setStatus('Peer disconnected');
      this.onDisconnected?.();
    }
  }

  private bindPeerErrors(peer: Peer): void {
    peer.on('error', (err) => {
      this.setStatus(`Peer error: ${err.message}`);
    });
  }

  private setStatus(status: string): void {
    this.zone.run(() => {
      this.onStatusChange?.(status);
    });
  }
}
