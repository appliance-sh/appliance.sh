import { Result } from '../result';
import { ClientConfig, ListOptions } from './types';
import { Project, ProjectInput } from '../models/project';
import { Environment, EnvironmentInput } from '../models/environment';
import { Deployment } from '../models/deployment';
import { ApiKeyCreateResponse } from '../models/api-key';
import { signRequest } from '../signing';

export class ApplianceClient {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly credentials?: { keyId: string; secret: string };

  constructor(config: ClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.timeout = config.timeout ?? 30000;
    this.credentials = config.credentials;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<Result<T>> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const url = `${this.baseUrl}${path}`;
      const bodyStr = body ? JSON.stringify(body) : undefined;

      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };

      if (this.credentials && bodyStr) {
        const sigHeaders = await signRequest(this.credentials, {
          method: method.toUpperCase(),
          url,
          headers,
          body: bodyStr,
        });
        Object.assign(headers, sigHeaders);
      } else if (this.credentials) {
        const sigHeaders = await signRequest(this.credentials, {
          method: method.toUpperCase(),
          url,
          headers,
        });
        Object.assign(headers, sigHeaders);
      }

      const response = await fetch(url, {
        method,
        headers,
        body: bodyStr,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();
        return {
          success: false,
          error: new Error(`HTTP ${response.status}: ${errorBody}`),
        };
      }

      const data = await response.json();
      return { success: true, data: data as T };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  // Bootstrap methods (no signature auth)
  async bootstrap(token: string, name: string): Promise<Result<ApiKeyCreateResponse>> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(`${this.baseUrl}/bootstrap/create-key`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-bootstrap-token': token,
        },
        body: JSON.stringify({ name }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();
        return {
          success: false,
          error: new Error(`HTTP ${response.status}: ${errorBody}`),
        };
      }

      const data = await response.json();
      return { success: true, data: data as ApiKeyCreateResponse };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  async getBootstrapStatus(): Promise<Result<{ initialized: boolean }>> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(`${this.baseUrl}/bootstrap/status`, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();
        return {
          success: false,
          error: new Error(`HTTP ${response.status}: ${errorBody}`),
        };
      }

      const data = await response.json();
      return { success: true, data: data as { initialized: boolean } };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  // Project methods
  async createProject(input: ProjectInput): Promise<Result<Project>> {
    return this.request<Project>('POST', '/api/v1/projects', input);
  }

  async getProject(id: string): Promise<Result<Project>> {
    return this.request<Project>('GET', `/api/v1/projects/${id}`);
  }

  async listProjects(options?: ListOptions): Promise<Result<Project[]>> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    const query = params.toString();
    return this.request<Project[]>('GET', `/api/v1/projects${query ? `?${query}` : ''}`);
  }

  async deleteProject(id: string): Promise<Result<void>> {
    return this.request<void>('DELETE', `/api/v1/projects/${id}`);
  }

  // Environment methods
  async createEnvironment(input: EnvironmentInput): Promise<Result<Environment>> {
    return this.request<Environment>('POST', `/api/v1/projects/${input.projectId}/environments`, input);
  }

  async getEnvironment(projectId: string, id: string): Promise<Result<Environment>> {
    return this.request<Environment>('GET', `/api/v1/projects/${projectId}/environments/${id}`);
  }

  async listEnvironments(projectId: string, options?: ListOptions): Promise<Result<Environment[]>> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    const query = params.toString();
    return this.request<Environment[]>('GET', `/api/v1/projects/${projectId}/environments${query ? `?${query}` : ''}`);
  }

  async deleteEnvironment(projectId: string, id: string): Promise<Result<void>> {
    return this.request<void>('DELETE', `/api/v1/projects/${projectId}/environments/${id}`);
  }

  // Deployment methods
  async deploy(environmentId: string): Promise<Result<Deployment>> {
    return this.request<Deployment>('POST', '/api/v1/deployments', {
      environmentId,
      action: 'deploy',
    });
  }

  async destroy(environmentId: string): Promise<Result<Deployment>> {
    return this.request<Deployment>('POST', '/api/v1/deployments', {
      environmentId,
      action: 'destroy',
    });
  }

  async getDeployment(id: string): Promise<Result<Deployment>> {
    return this.request<Deployment>('GET', `/api/v1/deployments/${id}`);
  }
}

export function createApplianceClient(config: ClientConfig): ApplianceClient {
  return new ApplianceClient(config);
}
