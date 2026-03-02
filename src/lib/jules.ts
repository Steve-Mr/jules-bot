import { Context } from 'hono';

export interface Env {
  TELEGRAM_TOKEN: string;
  JULES_API_KEY: string;
  ADMIN_USER_ID: string; // Comma separated IDs
  JULES_NOTIFICATIONS_KV?: KVNamespace;
}

export interface CreateSessionOptions {
  title?: string;
  startingBranch?: string;
  requirePlanApproval?: boolean;
  automationMode?: 'AUTO_CREATE_PR' | 'AUTOMATION_MODE_UNSPECIFIED';
}

export class JulesClient {
  private baseUrl = 'https://jules.googleapis.com/v1alpha';
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async fetch<T = any>(path: string, options: RequestInit = {}): Promise<T> {
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

    return response.json() as Promise<T>;
  }

  async listSources(): Promise<{ sources?: any[]; nextPageToken?: string }> {
    return this.fetch('/sources');
  }

  async listSessions(): Promise<{ sessions?: any[]; nextPageToken?: string }> {
    return this.fetch('/sessions');
  }

  async getSession(id: string): Promise<any> {
    return this.fetch(`/sessions/${id}`);
  }

  async createSession(sourceName: string, prompt: string, options: CreateSessionOptions = {}): Promise<any> {
    return this.fetch('/sessions', {
      method: 'POST',
      body: JSON.stringify({
        prompt: prompt,
        title: options.title || prompt.substring(0, 30),
        sourceContext: {
          source: sourceName,
          githubRepoContext: {
            startingBranch: options.startingBranch || 'main'
          }
        },
        requirePlanApproval: options.requirePlanApproval ?? false,
        automationMode: options.automationMode || 'AUTOMATION_MODE_UNSPECIFIED'
      }),
    });
  }

  async sendMessage(sessionId: string, message: string): Promise<any> {
    return this.fetch(`/sessions/${sessionId}:sendMessage`, {
      method: 'POST',
      body: JSON.stringify({ prompt: message }),
    });
  }

  async approvePlan(sessionId: string): Promise<any> {
    return this.fetch(`/sessions/${sessionId}:approvePlan`, {
      method: 'POST',
    });
  }

  async getActivities(sessionId: string, pageToken?: string, pageSize = 50): Promise<{ activities?: any[]; nextPageToken?: string }> {
    const path = `/sessions/${sessionId}/activities?pageSize=${pageSize}${pageToken ? `&pageToken=${pageToken}` : ''}`;
    return this.fetch(path);
  }

  async getRecentActivities(sessionId: string, limit = 30) {
    const res = await this.getActivities(sessionId, undefined, Math.min(100, Math.max(1, limit)));
    return { activities: res.activities || [] };
  }

  async findActivityByKey(sessionId: string, activityKey: string, maxPages = 3) {
    let token: string | undefined = undefined;
    for (let i = 0; i < maxPages; i++) {
      const res = await this.getActivities(sessionId, token, 50);
      const found = (res.activities || []).find((a: any) => {
        const key = (a.name || '').split('/').pop();
        return key === activityKey;
      });
      if (found) return found;
      token = res.nextPageToken;
      if (!token) break;
    }
    return null;
  }

  /**
   * Helper to get ALL activities by following tokens
   */
  async getAllActivities(sessionId: string) {
      let all: any[] = [];
      let token: string | undefined = undefined;

      // Limit to 3 pages (150 activities) to reduce worker timeout risk
      for (let i = 0; i < 3; i++) {
          const res = await this.getActivities(sessionId, token);
          if (res.activities) {
              all = all.concat(res.activities);
          }
          token = res.nextPageToken;
          if (!token) break;
      }
      return { activities: all };
  }
}
