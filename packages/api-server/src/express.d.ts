import 'express-serve-static-core';

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
    apiKeyId?: string;
    /** Server-derived owning principal (tenant) for the request. */
    tenantId?: string;
    apiKeyRole?: import('@appliance.sh/sdk').ApiKeyRole;
    rawBody?: Buffer;
  }
}
