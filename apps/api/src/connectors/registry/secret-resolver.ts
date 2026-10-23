import type { SecretResolver } from '../interfaces/secret-resolver.js';

/**
 * Only variables in this namespace are reachable from connector config.
 *
 * Connector configuration is tenant data. Without a namespace a reference
 * such as `env:POSTGRES_PASSWORD` or `env:TELEGRAM_BOT_TOKEN` would send a
 * platform secret as a credential to a tenant-configured URL.
 */
export const CONNECTOR_SECRET_ENV_PREFIX = 'CONNECTOR_SECRET_';

const ENV_REF = /^env:(CONNECTOR_SECRET_[A-Z0-9_]{1,100})$/;

/**
 * Resolves `env:CONNECTOR_SECRET_<NAME>` references from the environment.
 *
 * Any other reference (another scheme, a bare name, a variable outside the
 * namespace) resolves to `undefined`, so the connector fails closed with a
 * configuration error. Env secrets are deployment-wide: per-tenant secret
 * scoping needs a tenant-aware secret manager behind this same interface.
 */
export class EnvSecretResolver implements SecretResolver {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  resolve(secretRef: string | undefined): string | undefined {
    const match = secretRef === undefined ? null : ENV_REF.exec(secretRef);
    if (!match) return undefined;
    const value = this.environment[match[1]];
    return value === undefined || value.length === 0 ? undefined : value;
  }
}
