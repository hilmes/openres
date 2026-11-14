import { expect, it } from "vitest";
import { contentSecurityPolicy } from "./csp";

it("allows scripts and stylesheets only with the request's nonce and nothing from another origin", () => {
  const policy = contentSecurityPolicy("abc123");
  expect(policy).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
  expect(policy).toContain("style-src 'self' 'nonce-abc123'");
  expect(policy).toContain("default-src 'self'");
  expect(policy).toContain("object-src 'none'");
  expect(policy).not.toMatch(/https?:|\*|unsafe-eval/);
  expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/);
  expect(policy).not.toContain("upgrade-insecure-requests");
});

it("adds eval only for the development build and the upgrade only behind HTTPS", () => {
  expect(contentSecurityPolicy("n", { dev: true })).toContain("'unsafe-eval'");
  expect(contentSecurityPolicy("n", { https: true })).toContain("upgrade-insecure-requests");
});
