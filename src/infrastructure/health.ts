/** One dependency the readiness probe looks at. `check` rejects when it is down. */
export interface DependencyCheck {
  readonly name: string;
  check(): Promise<void>;
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  dependencies: Record<string, string>;
}

/**
 * Runs every check at once and builds the same report users-api and posts-api
 * return: "ok" per healthy dependency, the failure text otherwise.
 */
export async function buildReport(checks: DependencyCheck[]): Promise<HealthReport> {
  const results = await Promise.all(
    checks.map(async ({ name, check }) => {
      try {
        await check();
        return [name, 'ok'] as const;
      } catch (error) {
        return [name, error instanceof Error ? error.message : String(error)] as const;
      }
    })
  );
  return {
    status: results.every(([, result]) => result === 'ok') ? 'ok' : 'degraded',
    dependencies: Object.fromEntries(results),
  };
}
