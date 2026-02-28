import { Context } from 'hono';

export interface Env {
  TELEGRAM_TOKEN: string;
  JULES_API_KEY: string;
  ADMIN_USER_ID: string; // Comma separated IDs
  JULES_NOTIFICATIONS_KV?: KVNamespace;
}

export class JulesClient {
  private baseUrl = 'https://jules.googleapis.com/v1alpha';
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async fetch(path: string, options: RequestInit = {}) {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        'X-Goog-Api-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Jules API Error: ${response.status} ${error}`);
    }

    return response.json();
  }

  async listSources() {
    return this.fetch('/sources');
  }

  async listSessions() {
    return this.fetch('/sessions');
  }

  async getSession(id: string) {
    return this.fetch(`/sessions/${id}`);
  }

  async createSession(sourceName: string, prompt: string, title?: string) {
    return this.fetch('/sessions', {
      method: 'POST',
      body: JSON.stringify({
        source: sourceName,
        prompt: prompt,
        title: title || prompt.substring(0, 30),
      }),
    });
  }

  async sendMessage(sessionId: string, message: string) {
    return this.fetch(`/sessions/${sessionId}:sendMessage`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
  }

  async approvePlan(sessionId: string) {
    return this.fetch(`/sessions/${sessionId}:approvePlan`, {
      method: 'POST',
    });
  }

  async getActivities(sessionId: string) {
    return this.fetch(`/sessions/${sessionId}/activities`);
  }
}
