# patches

`pnpm` patches applied to third-party packages on install, registered under `patchedDependencies`
in `pnpm-workspace.yaml`.

## `@getdevteam__analytics-web@0.3.1.patch`

Re-lays out the in-app feedback dialog that `allowUserFeedback` renders.

Published `@getdevteam/analytics-web@0.3.1` draws the dialog as a single 560 px column, so on a
desktop the page screenshot the visitor is meant to annotate is shrunk to a thumbnail.
The two-column build - screenshot on the left at up to 1600 px, tools, comment and actions on the
right, a pencil cursor over the drawing canvas - is merged in the platform repo but has not been
released, so this patch carries that build's `dist/` until it is.

Layout only.
The released single-column form still applies wherever two columns would not fit: viewports of
860 px or less, through a media query, and the states with no screenshot to show - comment-only
feedback after a failed capture, and the sent confirmation - through a `compact` class the
patched `setFormVisible` toggles.
Nothing else about the widget changes: the dialog's heading is site copy and is passed from
`apps/web/src/lib/analytics.ts` through the SDK's own `feedback.title` option, not patched in
here, so it survives this patch being dropped.
`apps/web/src/lib/analytics-feedback.test.ts` asserts both halves against the installed SDK.

The patch content is that build's `dist/`, dropped in through `pnpm patch`
`@getdevteam/analytics-web@0.3.1`, with three of its lines left at the released values: the
non-layout one it carried - its own default heading - and the two flex-sizing ones,
`flex-shrink: 0` on `.preview` and a 96 px `.comment` minimum.
Both of those are inert in the grid, and both still reach the flex fallbacks, where a preview that
cannot shrink pushes the comment box and Send off the bottom of a phone's screen behind a scroll
the dialog gives no sign of - so the fallbacks keep the released sizing that fits them on screen.
The chunk rename is that build's too: tsup names `feedback-*.js` after its content hash, so a
changed chunk is a renamed chunk, and `dist/index.js` and `dist/index.cjs` are in the patch only
because they import it by that name.

### Removing it

Once the SDK releases a version that ships the wide modal:

1. Bump `@getdevteam/analytics-web` in `apps/web/package.json`.
2. Delete the `patchedDependencies` entry from `pnpm-workspace.yaml`.
3. `pnpm install`, then delete this patch.

A patch is pinned to one exact version, so a bump that forgets step 2 fails the install with
`ERR_PNPM_UNUSED_PATCH` rather than quietly dropping the layout - none of this can outlive the
release it stands in for.
