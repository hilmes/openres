/**
 * The page Content Security Policy. Scripts and stylesheets run only with this request's
 * nonce, which Next.js reads from the header and applies to what it emits. Nothing is loaded
 * from another origin: fonts, icons and data are all served by this installation.
 */
export function contentSecurityPolicy(nonce: string, { dev = false, https = false }: { dev?: boolean; https?: boolean } = {}) {
  return [
    "default-src 'self'",
    // React's development build uses eval for error stacks; production never allows it.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    // The floor plan positions tables with style attributes. Attributes cannot run script.
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}
