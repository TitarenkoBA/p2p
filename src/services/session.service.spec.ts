import { WritableSignal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { AudioService } from './audio.service';
import { LocalMediaService } from './local-media.service';
import { ConnectionState, PeerEvent, PeerJsService, PeerRole } from './peerjs.service';
import { SessionService } from './session.service';

describe('SessionService', () => {
  const stream = {} as MediaStream;
  let events: Subject<PeerEvent>;
  let peer: {
    createRoom: ReturnType<typeof vi.fn>;
    joinRoom: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    sendMediaState: ReturnType<typeof vi.fn>;
    setOutgoingTrack: ReturnType<typeof vi.fn>;
  };
  let state: WritableSignal<ConnectionState>;
  let media: {
    acquire: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
    muteAll: ReturnType<typeof vi.fn>;
    isMicEnabled: WritableSignal<boolean>;
    isCamEnabled: WritableSignal<boolean>;
    isSharingScreen: WritableSignal<boolean>;
    startScreenShare: ReturnType<typeof vi.fn>;
    stopScreenShare: ReturnType<typeof vi.fn>;
    switchDevice: ReturnType<typeof vi.fn>;
    cameraTrack: ReturnType<typeof vi.fn>;
  };
  let audio: { play: ReturnType<typeof vi.fn>; playNotification: ReturnType<typeof vi.fn> };
  let session: SessionService;

  beforeEach(() => {
    events = new Subject();
    peer = {
      createRoom: vi.fn().mockResolvedValue('id'),
      joinRoom: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockReturnValue(true),
      disconnect: vi.fn(),
      sendMediaState: vi.fn(),
      setOutgoingTrack: vi.fn()
    };
    state = signal<ConnectionState>('idle');
    media = {
      acquire: vi.fn().mockResolvedValue(stream),
      release: vi.fn(),
      muteAll: vi.fn(),
      isMicEnabled: signal(false),
      isCamEnabled: signal(false),
      isSharingScreen: signal(false),
      startScreenShare: vi.fn(),
      stopScreenShare: vi.fn(),
      switchDevice: vi.fn(),
      cameraTrack: vi.fn()
    };
    audio = { play: vi.fn(), playNotification: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        {
          provide: PeerJsService,
          useValue: {
            ...peer,
            events$: events,
            state,
            role: signal<PeerRole>(null),
            myPeerId: signal(null),
            remotePeerId: signal(null),
            signalingLost: signal(false)
          }
        },
        { provide: LocalMediaService, useValue: media },
        { provide: AudioService, useValue: audio }
      ]
    });
    session = TestBed.inject(SessionService);
  });

  it('does not play the disconnect sound on startup', () => {
    TestBed.tick();
    expect(session.status()).toBe('Not connected');
    expect(audio.play).not.toHaveBeenCalled();
  });

  it('surfaces a failed join and releases the camera', async () => {
    peer.joinRoom.mockRejectedValue(new Error('Room not found.'));
    await session.joinRoom('nope');

    expect(session.status()).toBe('Room not found.');
    expect(session.tone()).toBe('error');
    expect(session.isBusy()).toBe(false);
    expect(media.release).toHaveBeenCalled();
  });

  it('does not connect when cancelled during the permission prompt', async () => {
    let grant!: (value: MediaStream) => void;
    media.acquire.mockReturnValue(new Promise((resolve) => (grant = resolve)));

    const joining = session.joinRoom('room');
    session.leave();
    grant(stream);
    await joining;

    expect(peer.joinRoom).not.toHaveBeenCalled();
    expect(session.isBusy()).toBe(false);
  });

  it('ignores the failure of a cancelled operation', async () => {
    let fail!: (err: Error) => void;
    peer.joinRoom.mockReturnValue(new Promise((_, reject) => (fail = reject)));

    const joining = session.joinRoom('room');
    await vi.waitFor(() => expect(peer.joinRoom).toHaveBeenCalled());
    session.leave();
    fail(new Error('Cancelled'));
    await joining;

    expect(session.status()).toBe('Not connected');
  });

  it('keeps media but mutes it when a guest leaves the host', () => {
    events.next({ type: 'left', role: 'host' });
    expect(media.muteAll).toHaveBeenCalled();
    expect(media.release).not.toHaveBeenCalled();
  });

  it('releases media when the host leaves the guest', () => {
    events.next({ type: 'left', role: 'guest' });
    expect(media.release).toHaveBeenCalled();
  });

  it('tells a connected peer about media changes', () => {
    TestBed.tick();
    expect(peer.sendMediaState).not.toHaveBeenCalled();

    state.set('connected');
    TestBed.tick();
    expect(peer.sendMediaState).toHaveBeenLastCalledWith({ mic: false, cam: false, screen: false });

    media.isCamEnabled.set(true);
    TestBed.tick();
    expect(peer.sendMediaState).toHaveBeenLastCalledWith({ mic: false, cam: true, screen: false });
  });

  it('only shares the screen with a connected peer', async () => {
    await session.toggleScreenShare();
    expect(media.startScreenShare).not.toHaveBeenCalled();

    const screen = { kind: 'video' } as MediaStreamTrack;
    media.startScreenShare.mockResolvedValue(screen);
    state.set('connected');
    await session.toggleScreenShare();
    expect(peer.setOutgoingTrack).toHaveBeenCalledWith('video', screen);
  });

  it('goes back to the camera when sharing stops', async () => {
    const camera = { kind: 'video' } as MediaStreamTrack;
    media.cameraTrack.mockReturnValue(camera);
    media.isSharingScreen.set(true);

    await session.toggleScreenShare();
    expect(media.stopScreenShare).toHaveBeenCalled();
    expect(peer.setOutgoingTrack).toHaveBeenCalledWith('video', camera);
  });

  it('stops sharing when the guest leaves the host', () => {
    events.next({ type: 'left', role: 'host' });
    expect(media.stopScreenShare).toHaveBeenCalled();
  });

  it('holds a new camera back while the screen is shared', async () => {
    media.isSharingScreen.set(true);
    media.switchDevice.mockResolvedValue({ track: {} as MediaStreamTrack, ok: true });
    await session.switchDevice('video', 'cam-2');
    expect(peer.setOutgoingTrack).not.toHaveBeenCalled();
  });

  it('reports a failed device switch but still sends the track it fell back to', async () => {
    const fallback = {} as MediaStreamTrack;
    media.switchDevice.mockResolvedValue({ track: fallback, ok: false });
    await session.switchDevice('audio', 'mic-2');
    expect(peer.setOutgoingTrack).toHaveBeenCalledWith('audio', fallback);
    expect(session.tone()).toBe('error');
  });

  it('records only messages that went out', () => {
    expect(session.sendMessage('  hi  ')).toBe(true);
    expect(peer.sendMessage).toHaveBeenCalledWith('hi');

    peer.sendMessage.mockReturnValue(false);
    expect(session.sendMessage('lost')).toBe(false);
    expect(session.sendMessage('   ')).toBe(false);
    expect(session.messages().map((message) => message.text)).toEqual(['hi']);
  });
});
