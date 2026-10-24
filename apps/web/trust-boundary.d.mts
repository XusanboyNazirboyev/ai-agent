export declare const CLIENT_IP_HEADER: 'x-agentcore-client-ip';
export declare const PROXY_AUTH_HEADER: 'x-agentcore-proxy-auth';
export declare function normalizeAddress(value: unknown): string | undefined;
export declare function clientAddress(
  peer: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustedHops: number,
): string | undefined;
export declare function applyTrustBoundary(
  headers: Record<string, string | string[] | undefined>,
  options: {
    peer: string | undefined;
    isApi: boolean;
    trustedHops: number;
    secret: string | undefined;
  },
): void;
