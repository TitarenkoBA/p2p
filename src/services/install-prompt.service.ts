import { Injectable, OnDestroy, signal } from '@angular/core';

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

@Injectable({ providedIn: 'root' })
export class InstallPromptService implements OnDestroy {
  private promptEvent?: BeforeInstallPromptEvent;

  readonly canInstall = signal(false);

  private readonly onBeforeInstallPrompt = (event: Event): void => {
    event.preventDefault();
    this.promptEvent = event as BeforeInstallPromptEvent;
    this.canInstall.set(true);
  };

  private readonly onAppInstalled = (): void => this.dismiss();

  constructor() {
    if (!window.matchMedia?.('(display-mode: standalone)').matches) {
      window.addEventListener('beforeinstallprompt', this.onBeforeInstallPrompt);
    }
    window.addEventListener('appinstalled', this.onAppInstalled);
  }

  ngOnDestroy(): void {
    window.removeEventListener('beforeinstallprompt', this.onBeforeInstallPrompt);
    window.removeEventListener('appinstalled', this.onAppInstalled);
  }

  async install(): Promise<void> {
    const event = this.promptEvent;
    if (!event) {
      return;
    }
    await event.prompt();
    await event.userChoice;
    this.dismiss();
  }

  dismiss(): void {
    this.promptEvent = undefined;
    this.canInstall.set(false);
  }
}
