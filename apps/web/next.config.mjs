import { loadRootEnv } from './load-root-env.mjs';

// Before the config object is evaluated, so DATABASE_URL is present for any
// code the server renders.
loadRootEnv();

/** @type {import('next').NextConfig} */
export default {
  // The db package ships TypeScript source rather than a build step, so Next
  // has to compile it alongside the app.
  transpilePackages: ['@pmdash/db', '@pmdash/logger'],
  // Caching is handled by `export const dynamic = 'force-dynamic'` in the root
  // layout rather than here: a stale metric is worse than a slow one when
  // someone is deciding what to escalate.
  typedRoutes: false,

  /*
   * Next 16 blocks cross-origin requests to dev resources, and treats
   * 127.0.0.1 and localhost as different origins. The test suite and the
   * browser pane both address the app as 127.0.0.1 while the dev server binds
   * localhost, so /_next/hmr was blocked -- which stops the dev client
   * bootstrapping and therefore stops React hydrating at all.
   *
   * The symptom is miserable to diagnose: pages render correctly, no error
   * reaches the browser console, and every client component simply sits inert.
   * It presents as "React is broken" rather than as a configuration warning
   * printed on the server.
   *
   * Development only; it has no effect on a production build.
   */
  // host.docker.internal is how the Linux container that generates the
  // authoritative screenshot baselines reaches this server.
  allowedDevOrigins: ['127.0.0.1', 'localhost', '[::1]', 'host.docker.internal'],
  // Next writes its own AGENTS.md on dev/build. Disabled because AGENTS.md is
  // this repo's single source of truth for agents (issue #35) and is written by
  // hand -- having the dev server silently overwrite it would be a bad day.
  agentRules: false,
};
