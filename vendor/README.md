# vendor

Third-party packages this repo installs from a file rather than from npm.

## `getdevteam-analytics-web-0.3.0.tgz`

`@getdevteam/analytics-web@0.3.0` - the first SDK release with the in-app user-feedback
widget (`allowUserFeedback`).
It is vendored because the version is not on npm yet: it publishes when
[getdevteam-ai/devteam-platform#277](https://github.com/getdevteam-ai/devteam-platform/pull/277)
merges to `main`.
`apps/web` depends on this tarball by path so the site can be built and deployed - locally
and in CI - before that happens.

The tarball is `npm pack` output from that PR's branch, unmodified: `dist/` plus the
package manifest, the same bytes npm would serve.

## `getdevteam-analytics-core-unpublished.tgz`

`@getdevteam/analytics-core` as it stands in the platform repo, which is **not** what npm
serves under any version.

`analytics-web@0.3.0` does `import { createClient, utf8ByteLength } from
"@getdevteam/analytics-core"` while pinning `"@getdevteam/analytics-core": "0.2.0"`, and the
published 0.2.0 does not export `utf8ByteLength` - it was added to core's source after 0.2.0
went out, without a version bump. So the two published artifacts do not fit together, and
rollup stops the build:

```
"utf8ByteLength" is not exported by .../@getdevteam/analytics-core/dist/index.js,
imported by .../@getdevteam/analytics-web/dist/index.js
```

The `overrides` entry in `pnpm-workspace.yaml` redirects every `@getdevteam/analytics-core`
resolution here, which stands in for the core release the platform still has to cut. This
tarball's manifest still says `0.2.0`; the version is a lie npm would never let us tell, and
it is exactly why the platform side needs a real bump.

## Removing all of this

Once the platform publishes a fixed pair - `analytics-core` at a version that exports
`utf8ByteLength`, and an `analytics-web` that depends on it:

1. Point `apps/web/package.json` back at `"@getdevteam/analytics-web": "^0.3.x"`.
2. Delete the `overrides` block from `pnpm-workspace.yaml`.
3. `pnpm install`, then delete this directory.

A path dependency is not reproducible for anyone who does not have this checkout, so none of
it should outlive the release it is standing in for.
