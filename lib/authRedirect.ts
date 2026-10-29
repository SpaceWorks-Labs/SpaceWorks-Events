/** Only application-local paths may be used after authentication. */
export function safeAuthRedirect(value: string | null | undefined) {
  const path = value?.trim();
  if (!path || !path.startsWith("/") || path.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(path)) return "/dashboard";
  try {
    const base = "https://auth.invalid";
    const url = new URL(path, base);
    // Dot segments are resolved here, so `/x/..//host` becomes `//host`: check
    // the normalised result, which a browser would read as another origin.
    const result = `${url.pathname}${url.search}${url.hash}`;
    return url.origin === base && result.startsWith("/") && !/^\/[/\\]/.test(result) ? result : "/dashboard";
  } catch {
    return "/dashboard";
  }
}
