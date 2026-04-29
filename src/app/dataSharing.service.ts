import { inject, Injectable, NgZone  } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class ShortenerService {
  private readonly workerUrl = 'https://link-shortener.zik2009.workers.dev/';
  private readonly zone = inject(NgZone );
  // private readonly proxyUrl = 'https://allorigins.win';

  constructor(private http: HttpClient) {}

  async createLink(longString: string): Promise<string> {
    const id = await firstValueFrom(
      this.http.post(this.workerUrl, longString, { responseType: 'text' })
    );
    return `${this.workerUrl}${id}`;
  }

  async getData(fullUrl: string): Promise<string> {
    try {
      return await this.zone.runOutsideAngular(() => 
        this.requestWithHardTimeout(fullUrl, 5000)
      );
    } catch (e) {
      console.warn('Первая попытка проигнорирована по таймауту, идем в прокси...');
      const proxyUrl = `https://corsproxy.io{encodeURIComponent(fullUrl)}`;
      return this.requestWithHardTimeout(proxyUrl, 5000);
    }
  }

  private async requestWithHardTimeout(url: string, ms: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error('HARD_TIMEOUT'));
      }, ms);

      fetch(url, { signal: controller.signal })
        .then(async (res) => {
          clearTimeout(timeoutId);
          if (res.ok) resolve(await res.text());
          else reject(new Error('FETCH_ERROR'));
        })
        .catch((err) => {
          clearTimeout(timeoutId);
          reject(err);
        });
    });
  }
}
