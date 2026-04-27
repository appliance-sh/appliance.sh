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

  private async request<T>(method: string, path: string, body?: unknown, timeout?: number): Promise<Result<T>> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout ?? this.timeout);

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
  async deploy(
    environmentId: string,
    options?: {
      /** Reference a build created via POST /api/v1/builds (either uploaded or external). */
      buildId?: string;
      /** Runtime environment variables. */
      environment?: Record<string, string>;
    }
  ): Promise<Result<Deployment>> {
    return this.request<Deployment>(
      'POST',
      '/api/v1/deployments',
      {
        environmentId,
        action: 'deploy',
        ...(options?.buildId ? { buildId: options.buildId } : {}),
        ...(options?.environment ? { environment: options.environment } : {}),
      },
      600000
    );
  }

  async destroy(environmentId: string): Promise<Result<Deployment>> {
    return this.request<Deployment>(
      'POST',
      '/api/v1/deployments',
      {
        environmentId,
        action: 'destroy',
      },
      600000
    );
  }

  /**
   * Run `pulumi refresh` against the environment's stack to reconcile
   * the Pulumi state file with live cloud reality. Topology is
   * unchanged. Useful after manual cloud-side edits, after a
   * force-cancel, or when investigating drift.
   */
  async refresh(environmentId: string): Promise<Result<Deployment>> {
    return this.request<Deployment>(
      'POST',
      '/api/v1/deployments',
      {
        environmentId,
        action: 'refresh',
      },
      600000
    );
  }

  async getDeployment(id: string): Promise<Result<Deployment>> {
    return this.request<Deployment>('GET', `/api/v1/deployments/${id}`);
  }

  /**
   * Request cancellation of an in-flight deployment.
   *
   * Cooperative (default): flips the deployment to `cancelling`;
   * the worker observes the flag on its next status poll, calls
   * stack.cancel() on the running Pulumi op, then runs
   * stack.refresh to reconcile state. Final terminal status is
   * `cancelled` — or `succeeded`/`failed` if the underlying
   * operation finished before cancel was observed.
   *
   * Force ({ force: true }): bypasses worker cooperation. The
   * server immediately writes a terminal `cancelled` status without
   * waiting for the worker. Pulumi state is NOT refreshed, so it
   * may diverge from reality — run `pulumi refresh` manually after
   * the worker is reaped. Use only when the worker is presumed
   * dead/stuck and a graceful cancel isn't completing.
   */
  async cancelDeployment(id: string, opts?: { force?: boolean }): Promise<Result<Deployment>> {
    return this.request<Deployment>(
      'POST',
      `/api/v1/deployments/${id}/cancel`,
      opts?.force ? { force: true } : undefined
    );
  }

  async listDeployments(options?: {
    limit?: number;
    offset?: number;
    environmentId?: string;
    projectId?: string;
  }): Promise<Result<Deployment[]>> {
    const params = new URLSearchParams();
    if (options?.limit !== undefined) params.set('limit', String(options.limit));
    if (options?.offset !== undefined) params.set('offset', String(options.offset));
    if (options?.environmentId) params.set('environmentId', options.environmentId);
    if (options?.projectId) params.set('projectId', options.projectId);
    const query = params.toString();
    return this.request<Deployment[]>('GET', `/api/v1/deployments${query ? `?${query}` : ''}`);
  }

  // Build methods

  /**
   * Create a Build record.
   *   - `createBuild()` — type: upload. Response includes a presigned
   *     `uploadUrl` the caller PUTs their zip to.
   *   - `createBuild({ uploadUrl: "<uri>" })` — type: remote-image.
   *     Caller references an image/content URL that already exists.
   *     Response is `{ buildId }` only.
   */
  async createBuild(options?: { uploadUrl?: string }): Promise<Result<{ buildId: string; uploadUrl?: string }>> {
    const body = options?.uploadUrl
      ? { type: 'remote-image' as const, uploadUrl: options.uploadUrl }
      : { type: 'upload' as const };
    return this.request<{ buildId: string; uploadUrl?: string }>('POST', '/api/v1/builds', body);
  }

  async uploadBuild(data: Buffer | Uint8Array): Promise<Result<{ buildId: string }>> {
    try {
      // Step 1: Request a presigned upload URL
      const createResult = await this.createBuild();
      if (!createResult.success) {
        return createResult;
      }

      const { buildId, uploadUrl } = createResult.data;
      if (!uploadUrl) {
        return { success: false, error: new Error('createBuild did not return an uploadUrl') };
      }

      // Step 2: Upload directly to the presigned URL
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 300000);

      const response = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': 'application/zip' },
        body: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();
        return { success: false, error: new Error(`Upload failed: HTTP ${response.status}: ${errorBody}`) };
      }

      return { success: true, data: { buildId } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }
}

export function createApplianceClient(config: ClientConfig): ApplianceClient {
  return new ApplianceClient(config);
}
