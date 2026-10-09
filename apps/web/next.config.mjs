import { loadRootEnv } from './load-root-env.mjs';

// Before the config object is evaluated, so DATABASE_URL is present for any
// code the server renders.
loadRootEnv();

/** @type {import('next').NextConfig} */
export default {
  // The db package ships TypeScript source rather than a build step, so Next
  // has to compile it alongside the app.
  transpilePackages: ['@pmdash/db'],
  // Caching is handled by `export const dynamic = 'force-dynamic'` in the root
  // layout rather than here: a stale metric is worse than a slow one when
  // someone is deciding what to escalate.
  typedRoutes: false,
  // Next writes its own AGENTS.md on dev/build. Disabled because AGENTS.md is
  // this repo's single source of truth for agents (issue #35) and is written by
  // hand -- having the dev server silently overwrite it would be a bad day.
  agentRules: false,
};
