import type {
  HostMessage,
  HostResponseMessage,
} from './HostMessage.ts';

export class SettingForgeHostClient {
    private readonly moduleId: string;

  private readonly pending =
    new Map<
      string,
      {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
      }
    >();

  constructor(moduleId: string) {
    this.moduleId = moduleId;
  
    window.addEventListener(
      'message',
      (event) => {
        const message =
          event.data as HostMessage | undefined;

        if (
          !message ||
          message.kind !== 'response'
        ) {
          return;
        }

        this.handleResponse(message);
      }
    );
  }

  get hosted(): boolean {
    return window.parent !== window;
  }

  emit(
    type: string,
    payload?: unknown
  ): void {
    if (!this.hosted) {
      return;
    }

    window.parent.postMessage(
      {
        kind: 'event',
        id: crypto.randomUUID(),
        sourceModuleId: this.moduleId,
        type,
        timestamp: Date.now(),
        payload,
      },
      '*'
    );
  }

  request<T>(
    type: string,
    payload?: unknown
  ): Promise<T> {
    if (!this.hosted) {
      return Promise.reject(
        new Error(
          'SettingForge host is not available.'
        )
      );
    }

    const id = crypto.randomUUID();

    return new Promise<T>(
      (resolve, reject) => {
        this.pending.set(id, {
          resolve: (value) =>
            resolve(value as T),
          reject,
        });

        window.parent.postMessage(
          {
            kind: 'request',
            id,
            sourceModuleId:
              this.moduleId,
            type,
            timestamp: Date.now(),
            payload,
          },
          '*'
        );
      }
    );
  }

  private handleResponse(
    response: HostResponseMessage
  ): void {
    const pending =
      this.pending.get(
        response.requestId
      );

    if (!pending) {
      return;
    }

    this.pending.delete(
      response.requestId
    );

    if (response.ok) {
      pending.resolve(
        response.payload
      );
    } else {
      pending.reject(
        new Error(
          response.error ??
            'SettingForge request failed.'
        )
      );
    }
  }
}

export const settingForgeHost =
  new SettingForgeHostClient(
    'sacscape'
  );