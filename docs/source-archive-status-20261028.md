# Source archive status — 2026-10-28

This feature branch archives the Astra development snapshot through local commit `020a098`. Thirteen local development commits are combined into one publication snapshot to exclude machine-specific paths from unpublished validation history. The original local histories and working copies remain intact. This is development work, not a release or a merge to main.

It includes the visual refresh, native keyboard/layout repairs, app-owned desktop harness, HTTP and embedded Tailscale connection paths, landing/recovery, capability reporting, Docker/installation workflows and provider-first authentication. Validation and limitations are recorded in their respective documents; native platform and Docker build gaps remain gaps.

The subsequent callback-waiting/model-catalog changes are preserved separately on `wip/astra-oauth-catalog-20261028`. That work has protocol/unit/native mock validation but its final browser visual regression and live native/backend activation were interrupted. It is not claimed complete.

The separate `archive/harness-lifecycle-20261028` and `archive/ionic-two-pages-20261028` branches preserve other previously committed local work. The Ionic experiment was rejected for the production UI and is retained only as an experiment, not integrated into this feature.

No auth stores, model credentials, databases, screenshots, build output, dependency directories or local execution logs are included in these new publication changes. Required application icon assets remain source assets. No runtime restart or new authorization was performed for publication.
