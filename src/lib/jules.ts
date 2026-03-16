import { Context } from 'hono';

export interface Env {
  TELEGRAM_TOKEN: string;
  WEBHOOK_SECRET_TOKEN?: string;
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

export interface Session {
  name: string;
  id: string;
  prompt: string;
  title?: string;
  displayName?: string;
  state: string;
  url?: string;
  createTime: string;
  updateTime: string;
}

export interface PlanStep {
  id: string;
  index: number;
  title: string;
  description: string;
}

export interface Plan {
  id: string;
  steps: PlanStep[];
  createTime: string;
}

export interface Artifact {
  changeSet?: {
    source: string;
    gitPatch: {
      baseCommitId: string;
      unidiffPatch: string;
      suggestedCommitMessage?: string;
    };
  };
  bashOutput?: {
    command: string;
    output: string;
    exitCode: number;
  };
  media?: {
    mimeType: string;
    data: string;
  };
}

export interface Activity {
  name: string;
  id: string;
  type?: string; // Some internal types use 'type'
  originator: string;
  description: string;
  createTime: string;
  artifacts?: Artifact[];
  planGenerated?: { plan: Plan };
  planApproved?: { planId: string };
  userMessaged?: { userMessage: string };
  agentMessaged?: { agentMessage: string };
  progressUpdated?: { title?: string; description: string };
  sessionCompleted?: Record<string, never>;
  sessionFailed?: { reason: string };
}

export interface Source {
  name: string;
  id: string;
  githubRepo?: {
    branches?: { displayName: string }[];
  };
}

export class JulesClient {
  private baseUrl = 'https://jules.googleapis.com/v1alpha';
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async fetch<T>(path: string, options: RequestInit = {}): Promise<T> {
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

  async listSources(options: { pageSize?: number; pageToken?: string } = {}): Promise<{ sources: Source[], nextPageToken?: string }> {
    const params = new URLSearchParams();
    if (options.pageSize) params.append('pageSize', options.pageSize.toString());
    if (options.pageToken) params.append('pageToken', options.pageToken);
    const query = params.toString();
    return this.fetch<{ sources: Source[], nextPageToken?: string }>(`/sources${query ? `?${query}` : ''}`);
  }

  async listSessions(): Promise<{ sessions: Session[], nextPageToken?: string }> {
    return this.fetch<{ sessions: Session[], nextPageToken?: string }>('/sessions');
  }

  async getSession(id: string): Promise<Session> {
    return this.fetch<Session>(`/sessions/${id}`);
  }

  async createSession(sourceName: string, prompt: string, options: CreateSessionOptions = {}): Promise<Session> {
    return this.fetch<Session>('/sessions', {
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

  async sendMessage(sessionId: string, message: string): Promise<void> {
    return this.fetch<void>(`/sessions/${sessionId}:sendMessage`, {
      method: 'POST',
      body: JSON.stringify({ prompt: message }),
    });
  }

  async approvePlan(sessionId: string): Promise<void> {
    return this.fetch<void>(`/sessions/${sessionId}:approvePlan`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async getActivities(sessionId: string, pageToken?: string): Promise<{ activities: Activity[], nextPageToken?: string }> {
    const path = `/sessions/${sessionId}/activities?pageSize=50${pageToken ? `&pageToken=${pageToken}` : ''}`;
    return this.fetch<{ activities: Activity[], nextPageToken?: string }>(path);
  }

  /**
   * Limit to 3 pages to save resources and reduce latency
   */
  async getAllActivities(sessionId: string): Promise<{ activities: Activity[] }> {
      let all: Activity[] = [];
      let token: string | undefined = undefined;
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
