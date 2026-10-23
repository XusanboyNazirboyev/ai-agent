/**
 * Resolves connector credentials from a secret reference.
 *
 * Committed configuration never contains plaintext secrets. A config stores a
 * `secretRef` (e.g. `env:CONNECTOR_SECRET_CRM_TOKEN`), and the resolver
 * returns the actual value at runtime. A resolver must only expose secrets
 * meant for connectors, never platform credentials. Resolved secrets must
 * never be logged or returned through APIs or diagnostics.
 *
 * The interface lives in `interfaces/` because both the registry and every
 * connector implementation depend on it; a connector must never read
 * `process.env` directly.
 */
export interface SecretResolver {
  resolve(secretRef: string | undefined): string | undefined;
}

/**
 * Secret resolver that never returns a value.
 *
 * Used to fail closed: a connector that needs a credential but was built
 * without a resolver reports a configuration error instead of sending an
 * unauthenticated request.
 */
export const nullSecretResolver: SecretResolver = {
  resolve: () => undefined,
};
