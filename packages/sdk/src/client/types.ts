export interface ClientConfig {
  baseUrl: string;
  timeout?: number;
  credentials?: {
    keyId: string;
    secret: string;
  };
}

export interface ListOptions {
  limit?: number;
  offset?: number;
}
