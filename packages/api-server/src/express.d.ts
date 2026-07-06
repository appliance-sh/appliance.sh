import 'express-serve-static-core';

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
    apiKeyId?: string;
    apiKeyRole?: import('@appliance.sh/sdk').ApiKeyRole;
    rawBody?: Buffer;
  }
}
