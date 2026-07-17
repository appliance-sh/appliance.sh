export interface ClientConfig {
  baseUrl: string;
  timeout?: number;
  credentials?: {
    keyId: string;
    secret: string;
  };
  /**
   * Product tag for the `x-appliance-client: <product>/<version>`
   * header (version-skew observability: server logs can attribute
   * traffic to a concrete client build). Defaults to `sdk`. Sent only
   * from NON-BROWSER contexts (no `document` global): browser/webview
   * requests would trip the CORS preflight of servers deployed before
   * the header was allow-listed. NOT part of the signed field set — it
   * must stay ignorable by old servers and stripped-by-proxies safe.
   */
  product?: string;
}

export interface ListOptions {
  limit?: number;
  offset?: number;
}
