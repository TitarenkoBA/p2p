import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ChatComponent } from '../components/chat/chat.component';
import { ClockComponent } from '../components/clock.component';
import { LoaderComponent } from '../components/loader/loader.component';
import { ParticipantListComponent, VolumeChange } from '../components/participant-list/participant-list.component';
import { RangeComponent } from '../components/range/range.component';
import { SelectComponent } from '../components/select/select.component';
import { SwitchComponent } from '../components/switch/switch.component';
import { VideoStageComponent } from '../components/video-stage/video-stage.component';
import { AppUpdateService } from '../services/app-update.service';
import { AudioService } from '../services/audio.service';
import { InstallPromptService } from '../services/install-prompt.service';
import { LocalMediaService } from '../services/local-media.service';
import { RoomService } from '../services/room/room.service';
import { SessionService } from '../services/session.service';

const ROOM_QUERY_PARAM = 'room';
const COPIED_FEEDBACK_MS = 1500;

@Component({
  selector: 'app-root',
  imports: [
    FormsModule,
    ChatComponent,
    ClockComponent,
    LoaderComponent,
    ParticipantListComponent,
    RangeComponent,
    SelectComponent,
    SwitchComponent,
    VideoStageComponent
  ],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements OnDestroy {
  protected readonly session = inject(SessionService);
  protected readonly room = inject(RoomService);
  protected readonly media = inject(LocalMediaService);
  protected readonly audio = inject(AudioService);
  protected readonly installPrompt = inject(InstallPromptService);
  protected readonly appUpdate = inject(AppUpdateService);

  protected readonly customRoomId = signal('');
  protected readonly remotePeerId = signal(new URLSearchParams(location.search).get(ROOM_QUERY_PARAM) ?? '');
  protected readonly isMediaStarted = signal(false);
  protected readonly copied = signal<'id' | 'link' | null>(null);
  protected readonly canShareInvite = typeof navigator.share === 'function';
  /** Per participant, on top of the shared volume. Not saved: IDs change with every call. */
  protected readonly volumes = signal<Record<string, number>>({});
  protected readonly myMedia = computed(() => ({
    mic: this.media.isMicEnabled(),
    cam: this.media.isCamEnabled(),
    screen: this.media.isSharingScreen()
  }));
  protected readonly hasHiddenRemoteMedia = computed(
    () =>
      !this.isMediaStarted() &&
      this.session.participants().some((link) => {
        const remote = link.media();
        return remote.mic || remote.cam || remote.screen;
      })
  );
  protected readonly shareScreenHint = computed(() => {
    const sharer = this.session.screenSharer();
    if (sharer) {
      return `${sharer.name()} is sharing their screen`;
    }
    return this.session.isConnected() ? '' : 'Available once someone joins';
  });

  private copiedTimer?: number;

  ngOnDestroy(): void {
    window.clearTimeout(this.copiedTimer);
    this.room.disconnect();
    this.media.release();
  }

  protected installApp(): Promise<void> {
    this.audio.play('click');
    return this.installPrompt.install();
  }

  protected closeInstallBanner(): void {
    this.audio.play('click');
    this.installPrompt.dismiss();
  }

  protected createRoom(): Promise<void> {
    return this.session.createRoom(this.customRoomId());
  }

  protected async joinRoom(): Promise<void> {
    if (this.remotePeerId().trim()) {
      await this.session.joinRoom(this.remotePeerId());
    }
  }

  protected setVolume({ id, value }: VolumeChange): void {
    this.volumes.update((volumes) => ({ ...volumes, [id]: value }));
  }

  protected toggleMediaStage(): void {
    this.audio.play('click');
    this.isMediaStarted.update((value) => !value);
  }

  protected toggleMicrophone(): void {
    this.audio.play('click');
    this.media.setMicEnabled(!this.media.isMicEnabled());
  }

  protected toggleCamera(): void {
    this.audio.play('click');
    this.media.setCamEnabled(!this.media.isCamEnabled());
  }

  protected toggleUiSounds(): void {
    this.audio.toggleMute();
    this.audio.play('click');
  }

  protected copyRoomId(): Promise<void> {
    return this.copy(this.session.roomId() ?? '', 'id');
  }

  protected copyInviteLink(): Promise<void> {
    return this.copy(this.inviteUrl(), 'link');
  }

  protected async shareInvite(): Promise<void> {
    this.audio.play('click');
    try {
      await navigator.share({ title: 'P2P Room', text: 'Join my P2P call', url: this.inviteUrl() });
    } catch (error) {
      // AbortError only means the user closed the share sheet.
      if ((error as Error).name !== 'AbortError') {
        await this.copyInviteLink();
      }
    }
  }

  private inviteUrl(): string {
    const url = new URL(location.href);
    url.search = new URLSearchParams({ [ROOM_QUERY_PARAM]: this.session.roomId() ?? '' }).toString();
    url.hash = '';
    return url.toString();
  }

  private async copy(text: string, kind: 'id' | 'link'): Promise<void> {
    this.audio.play('click');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      this.session.notify('Could not access the clipboard. Select the room ID and copy it manually.', 'error');
      return;
    }

    this.copied.set(kind);
    window.clearTimeout(this.copiedTimer);
    this.copiedTimer = window.setTimeout(() => this.copied.set(null), COPIED_FEEDBACK_MS);
  }
}
