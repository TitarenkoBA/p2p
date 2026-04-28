import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, timeout } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class ShortenerService {
  private readonly workerUrl = 'https://link-shortener.zik2009.workers.dev/';

  constructor(private http: HttpClient) {}

  // Шаг 1: Создание ссылки (Отправитель)
  async createLink(longString: string): Promise<string> {
    const id = await firstValueFrom(
      this.http.post(this.workerUrl, longString, { responseType: 'text' })
    );
    return `${this.workerUrl}${id}`;
  }

  // Шаг 2: Получение данных (Получатель)
  async getData(fullUrl: string): Promise<string> {
    return await firstValueFrom(
      this.http.get(fullUrl, { responseType: 'text' }).pipe(timeout(10000))
    );
  }
}
