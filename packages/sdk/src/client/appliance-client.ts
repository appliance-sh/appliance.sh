import { Result } from '../result';
import { ClientConfig, ListOptions } from './types';
import { Project, ProjectInput } from '../models/project';
import { Environment, EnvironmentInput } from '../models/environment';
import { Deployment } from '../models/deployment';

export class ApplianceClient {
  private readonly baseUrl: string;
  private readonly timeout: number;

  constructor(config: ClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.timeout = config.timeout ?? 30000;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<Result<T>> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
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

  // Project methods
  async createProject(input: ProjectInput): Promise<Result<Project>> {
    return this.request<Project>('POST', '/projects', input);
  }

  async getProject(id: string): Promise<Result<Project>> {
    return this.request<Project>('GET', `/projects/${id}`);
  }

  async listProjects(options?: ListOptions): Promise<Result<Project[]>> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    const query = params.toString();
    return this.request<Project[]>('GET', `/projects${query ? `?${query}` : ''}`);
  }

  async deleteProject(id: string): Promise<Result<void>> {
    return this.request<void>('DELETE', `/projects/${id}`);
  }

  // Environment methods
  async createEnvironment(input: EnvironmentInput): Promise<Result<Environment>> {
    return this.request<Environment>('POST', `/projects/${input.projectId}/environments`, input);
  }

  async getEnvironment(projectId: string, id: string): Promise<Result<Environment>> {
    return this.request<Environment>('GET', `/projects/${projectId}/environments/${id}`);
  }

  async listEnvironments(projectId: string, options?: ListOptions): Promise<Result<Environment[]>> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    const query = params.toString();
    return this.request<Environment[]>('GET', `/projects/${projectId}/environments${query ? `?${query}` : ''}`);
  }

  async deleteEnvironment(projectId: string, id: string): Promise<Result<void>> {
    return this.request<void>('DELETE', `/projects/${projectId}/environments/${id}`);
  }

  // Deployment methods
  async deploy(environmentId: string): Promise<Result<Deployment>> {
    return this.request<Deployment>('POST', '/deployments', {
      environmentId,
      action: 'deploy',
    });
  }

  async destroy(environmentId: string): Promise<Result<Deployment>> {
    return this.request<Deployment>('POST', '/deployments', {
      environmentId,
      action: 'destroy',
    });
  }

  async getDeployment(id: string): Promise<Result<Deployment>> {
    return this.request<Deployment>('GET', `/deployments/${id}`);
  }
}

export function createApplianceClient(config: ClientConfig): ApplianceClient {
  return new ApplianceClient(config);
}
