export const CANOPY_BASE_PATH = "/internal";
export const CANOPY_BASE_PATH_HEADER = "x-canopy-base-path";

export function basePathFor(pathname: string): string {
  return pathname === CANOPY_BASE_PATH || pathname.startsWith(`${CANOPY_BASE_PATH}/`)
    ? CANOPY_BASE_PATH
    : "";
}

export function stripBasePath(pathname: string, basePath: string): string {
  if (!basePath) return pathname;
  const stripped = pathname.slice(basePath.length);
  return stripped || "/";
}

export function routeRequest(request: Request, basePath: string): Request {
  const url = new URL(request.url);
  url.pathname = stripBasePath(url.pathname, basePath);

  // Only this Worker may assert the base path. Discard a client-supplied value
  // before adding the value derived from the request URL.
  const headers = new Headers(request.headers);
  headers.delete(CANOPY_BASE_PATH_HEADER);
  if (basePath) headers.set(CANOPY_BASE_PATH_HEADER, basePath);

  return new Request(url.toString(), {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: request.redirect,
  });
}
