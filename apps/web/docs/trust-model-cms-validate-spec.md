# Trust model: the schema change for `sleekdrops-cms/scripts/validate.ts`

**Status, 2026-10-02.** Optional follow-up, not a gate.
Nothing in this repository's build, tests or CI depends on it.

## Which validator this targets

The review frontmatter now carries a shared trust vocabulary, defined once in [`src/lib/trust.ts`](../src/lib/trust.ts) and applied to `productSchema` in [`src/content/frontmatter.ts`](../src/content/frontmatter.ts).
`sleekdrops-cms/scripts/validate.ts` historically mirrored that schema, so a hand-written review failed in the content repo's CI rather than in this site's build.
That repository is not visible from here, so the change it needs is written out below instead of committed.

The diff targets the **`productSchema` block of `sleekdrops-cms/scripts/validate.ts`**, as it was mirrored from this repository before this change, with `z` imported from `zod`.
Two facts to check before applying it:

- `frontmatter.ts` records that this `validate.ts` was **decommissioned on 2026-06-13**, when content moved to D1.
  If nothing runs it any more, there is nothing to do: this site's build enforces every rule below on its own.
- The live mirror is the agent's [`apps/agent/src/content/contract.ts`](../../agent/src/content/contract.ts).
  It has no product schema, because the pipeline never writes `postType: review`.
  It now exports the trust vocabulary (`METHOD_VERSIONS`, `PROVENANCES`, `BADGE_KINDS`, `ENABLED_BADGE_KINDS`, `SUB_SCORE_TOLERANCE`), and `contract.test.ts` asserts those match `trust.ts`.

Every new field is optional and a free-text badge string still validates, so the roughly 320 published reviews pass unchanged.

## What the site now enforces

- `product.methodVersion`: optional, one of the published method versions (today only `"1.0"`).
- `product.provenance`: optional, exactly `"retail"`, `"brand-sample"` or `"not-hands-on"`.
  `reviewUnit.acquisition` keeps its own `retail` / `loan` / `none`; when both are set they must say the same thing (`loan` is `brand-sample`, `none` is `not-hands-on`).
- `product.subScores`: optional array of at least two `{ label, score, weight }`, scores 1-5 and weights above 0 up to 1.
  The weights must sum to 1 (within 0.001), and the weighted sum must sit within **0.05** of `product.rating`.
- `product.badge`: a string.
  A registry kind is held to the registry: `"review-score"` is accepted (the review's own rating is its evidence), `"honest-negative"` is refused (it needs a note a review does not carry, so it belongs on a deal), and the switched-off price-history kinds `"lowest-price"` and `"below-average"` are refused.
  Any other string is a legacy label: it validates, and the site never prints it.

## The diff

The CMS cannot import from this repository, so the vocabulary is inlined; keep it in step with `src/lib/trust.ts`.

```diff
 import { z } from 'zod';
 
+// --- Trust vocabulary, mirrored from apps/web/src/lib/trust.ts ---------------
+const METHOD_VERSIONS = ['1.0'] as const;
+const PROVENANCES = ['retail', 'brand-sample', 'not-hands-on'] as const;
+const SUB_SCORE_TOLERANCE = 0.05;
+const BADGE_KINDS = new Set(['review-score', 'honest-negative', 'lowest-price', 'below-average']);
+// Kinds that are defined but refused until price checks are recorded.
+const DISABLED_BADGE_KINDS = new Set(['lowest-price', 'below-average']);
+// Kinds a review carries the evidence for itself.
+const PRODUCT_BADGE_KINDS = new Set(['review-score']);
+const ACQUISITION_PROVENANCE = { retail: 'retail', loan: 'brand-sample', none: 'not-hands-on' } as const;
+
-const productSchema = z.object({
-  name: z.string().min(1),
-  brand: z.string().min(1),
-  brandMark: z.string().length(1),
-  tagline: z.string().min(1),
-  rating: z.number().min(1).max(5),
-  retailer: z.string().min(1),
-  price: z.string().min(1),
-  priceWas: z.string().optional(),
-  badge: z.string().optional(),
-  pros: z.array(z.string().min(1)).min(3).max(5),
-  cons: z.array(z.string().min(1)).min(2).max(4),
-  specs: z.record(z.string()).optional(),
-});
+const productSchema = z
+  .object({
+    name: z.string().min(1),
+    brand: z.string().min(1),
+    brandMark: z.string().length(1),
+    tagline: z.string().min(1),
+    rating: z.number().min(1).max(5),
+    retailer: z.string().min(1),
+    price: z.string().min(1),
+    priceWas: z.string().optional(),
+    // A registry kind, or a legacy label that validates and is never printed.
+    badge: z.string().optional(),
+    pros: z.array(z.string().min(1)).min(3).max(5),
+    cons: z.array(z.string().min(1)).min(2).max(4),
+    specs: z.record(z.string()).optional(),
+    methodVersion: z.enum(METHOD_VERSIONS).optional(),
+    provenance: z.enum(PROVENANCES).optional(),
+    subScores: z
+      .array(z.object({ label: z.string().min(1), score: z.number().min(1).max(5), weight: z.number().positive().max(1) }))
+      .min(2)
+      .optional(),
+  })
+  .superRefine((product, ctx) => {
+    if (product.subScores) {
+      const weights = product.subScores.reduce((sum, s) => sum + s.weight, 0);
+      const recomputed = product.subScores.reduce((sum, s) => sum + s.score * s.weight, 0);
+      if (Math.abs(weights - 1) > 0.001 + 1e-9) {
+        ctx.addIssue({ code: 'custom', path: ['subScores'], message: `sub-score weights sum to ${weights.toFixed(3)}, not 1` });
+      } else if (Math.abs(recomputed - product.rating) > SUB_SCORE_TOLERANCE + 1e-9) {
+        ctx.addIssue({
+          code: 'custom',
+          path: ['subScores'],
+          message: `sub-scores recompute to ${recomputed.toFixed(2)}, more than ${SUB_SCORE_TOLERANCE} from the headline ${product.rating.toFixed(1)}`,
+        });
+      }
+    }
+    const badge = product.badge;
+    if (badge === undefined || !BADGE_KINDS.has(badge)) return;
+    if (DISABLED_BADGE_KINDS.has(badge)) {
+      ctx.addIssue({ code: 'custom', path: ['badge'], message: `badge kind "${badge}" is switched off until the data behind it is collected` });
+    } else if (!PRODUCT_BADGE_KINDS.has(badge)) {
+      ctx.addIssue({ code: 'custom', path: ['badge'], message: `badge kind "${badge}" needs evidence a review does not carry, so it belongs on a deal` });
+    }
+  });
```

And on the frontmatter object, after the existing `postType: 'review'` refinement:

```diff
   .refine(
     (data) => data.postType !== 'review' || data.product !== undefined,
     { message: "postType: 'review' requires a `product` object in frontmatter" },
-  );
+  )
+  .refine(
+    (data) =>
+      data.product?.provenance === undefined ||
+      data.reviewUnit === undefined ||
+      data.product.provenance === ACQUISITION_PROVENANCE[data.reviewUnit.acquisition],
+    {
+      message: '`product.provenance` and `reviewUnit.acquisition` describe the same unit and must agree',
+      path: ['product', 'provenance'],
+    },
+  );
```

If the CMS copy predates `reviewUnit`, skip the second hunk and the `ACQUISITION_PROVENANCE` line.

## Keeping it in step

When a method version is published, a badge kind is switched on, or a kind is added to the registry in `src/lib/trust.ts`, the matching constant above changes with it.
The site's own build enforces the rules either way, so a CMS copy that falls behind only moves the failure from the content repo's CI to this site's build.
