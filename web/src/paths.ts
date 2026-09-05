export const CANOPY_BASE_PATH = "/internal";

export function appBasePath(pathname?: string): string {
  const currentPath = pathname
    ?? (globalThis as unknown as { location?: { pathname: string } }).location?.pathname
    ?? "/";
  return currentPath === CANOPY_BASE_PATH || currentPath.startsWith(`${CANOPY_BASE_PATH}/`)
    ? CANOPY_BASE_PATH
    : "";
}

export function appPath(target: string, pathname?: string): string {
  if (!target.startsWith("/")) throw new Error(`Canopy app paths must start with /: ${target}`);
  return `${appBasePath(pathname)}${target}`;
}
