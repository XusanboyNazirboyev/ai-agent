export function assertSeedAllowed(nodeEnv = process.env.NODE_ENV): void {
  if (nodeEnv === 'production') {
    throw new Error('The development seed is disabled in production');
  }
}
