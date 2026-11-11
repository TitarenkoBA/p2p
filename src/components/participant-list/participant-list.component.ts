import { Component, input, output } from '@angular/core';
import { PeerLink } from '../../services/room/peer-link';
import { PeerMediaState } from '../../services/room/protocol';
import { RangeComponent } from '../range/range.component';

export interface VolumeChange {
  id: string;
  value: number;
}

/** Who is in the room, what they have switched on, and how loud each of them plays here. */
@Component({
  selector: 'participant-list',
  imports: [RangeComponent],
  templateUrl: './participant-list.component.html',
  styleUrl: './participant-list.component.css'
})
export class ParticipantListComponent {
  participants = input.required<PeerLink[]>();
  myName = input('');
  isHost = input(false);
  capacity = input.required<number>();
  myMedia = input.required<PeerMediaState>();
  volumes = input<Partial<Record<string, number>>>({});
  volumeChange = output<VolumeChange>();

  protected describe(media: PeerMediaState): string {
    if (media.screen) {
      return 'Sharing screen';
    }
    const parts = [media.mic ? 'Mic on' : 'Mic off', media.cam ? 'camera on' : 'camera off'];
    return parts.join(', ');
  }
}
