import { Injectable, inject, signal } from '@angular/core';
import { SwUpdate } from '@angular/service-worker';
import { filter } from 'rxjs';

/**
 * Tells the user when the service worker has a newer build. Clients of different versions
 * may not understand each other in a room, so mixed versions should not last long.
 */
@Injectable({ providedIn: 'root' })
export class AppUpdateService {
  private readonly updates = inject(SwUpdate, { optional: true });

  readonly isReady = signal(false);

  constructor() {
    if (this.updates?.isEnabled) {
      this.updates.versionUpdates
        .pipe(filter((event) => event.type === 'VERSION_READY'))
        .subscribe(() => this.isReady.set(true));
    }
  }

  async reload(): Promise<void> {
    try {
      await this.updates?.activateUpdate();
    } catch (error) {
      console.warn('Could not activate the update', error);
    }
    location.reload();
  }
}
