/**
 * NAT-057: RouteDirector rollout — unified answer turn orchestration.
 * Enable with NATIVELY_ROUTE_DIRECTOR=1 for one release.
 */
export function isRouteDirectorEnabled(): boolean {
  const v = process.env.NATIVELY_ROUTE_DIRECTOR;
  return v === '1' || v === 'true';
}
