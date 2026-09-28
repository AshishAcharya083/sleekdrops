# ads.txt source

`ads.txt` in this folder is the authorised-sellers file **Journey by Mediavine issues
for sleekdrops.com** (Journey dashboard → Settings → Ad Setup → download ads.txt).
It is not committed until Journey issues one.

`scripts/generate-ads-txt.mjs` copies it to `public/ads.txt` on a **production**
build only, so it is served at `https://sleekdrops.com/ads.txt`. Preview builds
publish no seller record at all: `sleekdrops.pages.dev` is not a domain the
partner has approved, and an ads.txt there would authorise sellers for a site
that does not exist.

Setting `ADS_TXT_URL` (a production GitHub Environment variable) makes the build
fetch the file from that URL instead of using this copy, for a partner that
hosts the file itself. Either way the content is validated - at least one
`domain, seller id, DIRECT|RESELLER` record - and an invalid file fails the
build rather than publishing a file that authorises nobody.

**When the Journey dashboard's ads.txt health check goes yellow or red**, download
the new file, replace `ads.txt` here, merge to `main`, and press the dashboard's
refresh once the deploy is live. The file is served straight from the edge,
so there is nothing else to clear.

Exclusivity: Journey requires that no other programmatic seller appears in this
file. Do not add lines for another network - that is how a site loses its
Journey account.
