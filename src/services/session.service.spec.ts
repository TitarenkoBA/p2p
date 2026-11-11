import { WritableSignal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { AudioService } from './audio.service';
import { LocalMediaService } from './local-media.service';
import { PeerLink } from './room/peer-link';
import { MEDIA_OFF, PeerMediaState } from './room/protocol';
import { ConnectionState, PeerRole, RoomEvent, RoomService } from './room/room.service';
import { SessionService } from './session.service';

function fakeLink(id: string, name: string, media: Partial<PeerMediaState> = {}): PeerLink {
  return {
    id,
    name: signal(name),
    media: signal({ ...MEDIA_OFF, ...media }),
    status: signal('connected')
  } as unknown as PeerLink;
}

describe('SessionService', () => {
  const stream = {} as MediaStream;
  let events: Subject<RoomEvent>;
  let peer: {
    createRoom: ReturnType<typeof vi.fn>;
    joinRoom: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    sendMediaState: ReturnType<typeof vi.fn>;
    setOutgoingTrack: ReturnType<typeof vi.fn>;
  };
  let state: WritableSignal<ConnectionState>;
  let participants: WritableSignal<PeerLink[]>;
  let myPeerId: WritableSignal<string | null>;
  let media: {
    acquire: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
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
    participants = signal<PeerLink[]>([]);
    myPeerId = signal<string | null>(null);
    media = {
      acquire: vi.fn().mockResolvedValue(stream),
      release: vi.fn(),
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
          provide: RoomService,
          useValue: {
            ...peer,
            events$: events,
            state,
            participants,
            myPeerId,
            capacity: 4,
            role: signal<PeerRole>(null),
            roomId: signal(null),
            myName: signal(''),
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

  it('passes the chosen name to the room', async () => {
    session.setName('Ann');
    await session.joinRoom('room');
    expect(peer.joinRoom).toHaveBeenCalledWith('room', stream, 'Ann');
  });

  it('keeps media running as people come and go', () => {
    events.next({ type: 'joined', name: 'Ann' });
    events.next({ type: 'left', name: 'Ann' });
    expect(media.release).not.toHaveBeenCalled();
    expect(session.messages().map((message) => message.text)).toEqual(['Ann joined', 'Ann left']);
  });

  it('releases media when the host closes the room', () => {
    events.next({ type: 'room-closed' });
    expect(media.release).toHaveBeenCalled();
    expect(session.status()).toBe('The host closed the room.');
  });

  it('counts everyone in the status', () => {
    state.set('connected');
    participants.set([fakeLink('a', 'Ann'), fakeLink('b', 'Bob')]);
    expect(session.status()).toBe('Connected · 3 of 4 in the room');
  });

  it('keeps the author of chat messages', () => {
    events.next({ type: 'message', from: 'Ann', text: 'hi' });
    expect(session.messages()[0]).toMatchObject({ author: 'peer', name: 'Ann', text: 'hi' });
  });

  it('tells the room about media changes', () => {
    TestBed.tick();
    expect(peer.sendMediaState).toHaveBeenLastCalledWith({ mic: false, cam: false, screen: false });

    media.isCamEnabled.set(true);
    TestBed.tick();
    expect(peer.sendMediaState).toHaveBeenLastCalledWith({ mic: false, cam: true, screen: false });
  });

  it('does not share while someone else is sharing', async () => {
    state.set('connected');
    participants.set([fakeLink('a', 'Ann', { screen: true })]);
    await session.toggleScreenShare();
    expect(media.startScreenShare).not.toHaveBeenCalled();
  });

  it('backs off when someone with a smaller ID shares at the same time', () => {
    myPeerId.set('b');
    media.isSharingScreen.set(true);
    participants.set([fakeLink('c', 'Cid', { screen: true })]);
    TestBed.tick();
    expect(media.stopScreenShare).not.toHaveBeenCalled();

    participants.set([fakeLink('a', 'Ann', { screen: true })]);
    TestBed.tick();
    expect(media.stopScreenShare).toHaveBeenCalled();
  });

  it('only shares the screen when someone is in the room', async () => {
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

  it('stops sharing when the last participant leaves', () => {
    participants.set([fakeLink('a', 'Ann')]);
    media.isSharingScreen.set(true);
    TestBed.tick();
    expect(media.stopScreenShare).not.toHaveBeenCalled();

    participants.set([]);
    TestBed.tick();
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
