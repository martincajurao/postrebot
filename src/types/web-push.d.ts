declare module 'web-push' {
  /** A push subscription endpoint (stored in the browser before being sent to the server). */
  export interface PushSubscription {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    expirationTime?: number | null;
  }

  /** Error thrown by sendNotification — carries the HTTP status code from the push service. */
  export interface PushError extends Error {
    statusCode?: number;
    headers?: Record<string, string>;
  }

  /** Set VAPID details (subject + key pair). Must be called before sendNotification. */
  export function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;

  /** Generate a new VAPID key pair. */
  export function generateVAPIDKeys(): { publicKey: string; privateKey: string };

  /** Send a push message to a subscription. Rejects with a PushError on failure. */
  export function sendNotification(subscription: PushSubscription, payload?: string | object, options?: Record<string, unknown>): Promise<any>;

  /** Send a push message without awaiting (alias used internally by some wrappers). */
  export function sendToSubscription(subscription: PushSubscription, payload?: string | object, options?: Record<string, unknown>): Promise<any>;
}
