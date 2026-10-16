# ads.txt sources

`https://sleekdrops.com/ads.txt` is generated on every **production** build by
`scripts/generate-ads-txt.mjs` (the rule itself is `src/lib/ads-txt.mjs`). While the
site applies to both of its ad partners it is the union of two sources, each record
written once:

- **Google AdSense** - one `google.com` record, generated from the production
  publisher id (`ADSENSE_CLIENT` → `PUBLIC_ADSENSE_CLIENT`). Nothing to commit.
- **Journey by Mediavine** - the authorised-sellers file Journey issues for
  sleekdrops.com once it approves the site (Journey dashboard → Settings → Ad Setup →
  download ads.txt). Commit it here as `ads.txt`; it is not committed until Journey
  issues one. Setting `ADS_TXT_URL` (a production GitHub Environment variable) makes
  the build fetch the file from that URL instead of using this copy, for a partner
  that hosts the file itself.

Preview builds publish no seller record at all: `sleekdrops.pages.dev` is not a
domain either partner has approved, and an ads.txt there would authorise sellers for
a site that does not exist. Journey's file is validated - at least one
`domain, seller id, DIRECT|RESELLER` record - and an invalid file, or a publisher id
that is not `ca-pub-<digits>`, fails the build rather than publishing a file that
authorises nobody.

**When the Journey dashboard's ads.txt health check goes yellow or red**, download
the new file, replace `ads.txt` here, merge to `main`, and press the dashboard's
refresh once the deploy is live. The file is served straight from the edge, so
there is nothing else to clear.

**Exclusivity.** Journey requires that no other programmatic seller appears in this
file and no other ad tag on the page once it serves ads. The two partners coexist
only while the site is applying to both. The day one of them launches, remove the
other: for Journey, empty the production `ADSENSE_CLIENT` variable (the Google record
and the AdSense tag drop out on the next build); for AdSense, empty
`MEDIAVINE_SITE_ID` and delete `ads.txt` here.
