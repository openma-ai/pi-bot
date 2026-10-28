# Harness deployment validation — 2026-10-27

Checkout: `feat/astra-visual-refresh`, starting from `e7c11ea`; base deployment implementation committed as `abcb273`. Subsequent validation is recorded below. macOS arm64, Node 24.18.0, Docker Engine 25.0.3. No login, service password setup, real model credentials, paid model calls, existing runtime mutation, host service install or network configuration was performed.

## Verified

- `node --test deploy/harness.test.mjs`: 2/2; invalid gateway/origin/port configuration and isolated runtime environment.
- Node syntax checks, shell syntax check, `git diff --check`, Compose configuration validation.
- Real prepared user installation in `/tmp/pibo-harness-install-qa-20261027`, separate from the source and existing app data; local listener `127.0.0.1:54186` only.
- First installed release `20261027154613246-bdeb6d87`: actual daemon status `ready`, model `未配置`, `setupRequired: true`. A synthetic SDK message was rejected immediately with `setupRequired: Configure native Pi first`; token usage and cost remained zero. This used the real Pi factory, not a fixture/empty executor.
- Running-instance upgrade refused before copying/replacing data. Graceful stop succeeded.
- Upgrade release `20261027155142997-fc85b046` became ready against the same isolated data. Automatic pre-upgrade snapshot: `20261027155200803-bc74573e`.
- Rollback restored the original release and matching data; a synthetic post-upgrade workspace file disappeared from current data and remained in backup `20261027155443823-b7d7a6a7`. The rolled-back daemon became ready again.
- Password setup refused with a clear instruction when the authenticated gateway was not configured; no password was entered.
- Uninstall exercised only against this QA installation: both recognized application versions removed; data, config, server log and snapshots retained. The QA process was stopped.
- After adding prepared-dependency external-link rejection, a fresh prepared installation at `/tmp/pibo-harness-package-final-qa-20261027` succeeded (`20261027155932304-1d382329`); its application release was then uninstalled without starting another server.
- Docker container `pibo-harness-deploy-qa-20261027`: cached `pibo-tailnet-direct:phone-0950971` dependencies, current source/vendor/launcher mounted read-only, separate tmpfs data, no network and no host ports. Real daemon `/readyz` returned 200 and status showed missing model. `docker stop --time 45` yielded exit 0. Container remains stopped as evidence.
- Offline volume backup and restore round trip with synthetic text only: projects `pibo-volume-qa-20261027` and `pibo-volume-restored-qa-20261027`; source/restored `harness-data` and `tailnet-state` are newly created QA volumes. Restored content matched; directory owner/mode `1000:1000 700`, file `1000:1000 600`. A second restore to the same project was rejected, preserving existing volumes. Archive is `/tmp/pibo-volume-backup-qa-20261027`.

## Limits and fixes found

- The new `Dockerfile.harness` was inspected, and its launcher/runtime were exercised in a cached Linux image. The latest build preflight found approximately 3.55 GiB available, below the recommended 5–6 GiB for the uncached dependency layer and export. No new distributable image was built; the detailed estimate is in [build preflight](harness-build-preflight-20261027.md).
- Installer `--prepared` was exercised. The default `npm ci --ignore-scripts` path is implemented using the existing project lockfile/build commands but was not separately downloaded and installed during this run.
- Existing-machine lifecycle was measured on macOS arm64; Linux daemon execution was measured in the cached container. Linux user installer, amd64 Docker, Windows native installation, public HTTPS, Tailscale login/Serve, remote password login and actual model responses were not exercised.
- Startup testing found missing `vendor/openmatter` in the initial staging set and macOS `/tmp` executable URL canonicalization. Both packaging/launcher paths were corrected before successful startup.
- An initial sandboxed listen attempt returned `EPERM` for the isolated loopback port. The authorized isolated validation then ran with the required execution permission. Docker socket required the same tool permission. No denial was bypassed and no host permission setting was changed.
- Existing `pibo-tailnet-test-live-1` and `pibo-tailnet-test-tailnet-persistent-1` containers and their data were left untouched. The heavy existing desktop/VNC Dockerfile is unchanged.

The retained test data contains only synthetic inputs and runtime-generated local control tokens; do not upload raw data directories or logs as public artifacts. None were copied into the repository.

## Small persistent-container smoke, 2026-10-27

After the [read-only build preflight](harness-build-preflight-20261027.md), no new image was built or pulled. The following reusable bounded smoke ran against cached Linux arm64 image `sha256:cea45f6d5add35beabbc774ad7b8fedd5cf1197677203b326288fc32088c7012` (`pibo-tailnet-direct:phone-0950971`) with current `src`, `vendor`, `deploy`, package manifest and GUI mounted read-only:

```sh
node deploy/smoke-persistence.mjs \
  --image pibo-tailnet-direct:phone-0950971 \
  --name pibo-harness-persistence-qa-20261027 \
  --out /tmp/pibo-harness-persistence-evidence-20261027
```

The script refuses existing container/volume names, uses only an already cached image (`--pull=never`), caps each Docker operation at 60 seconds and refuses QA data above 20 MiB. A new empty volume uses `volume-nocopy`; a separate one-shot init container sets only that new volume's owner to uid/gid 1000. Runtime has `--network none`, no published ports, `--read-only`, all capabilities dropped, no-new-privileges, 768 MiB memory, 1 CPU and 256 PID limit. No old runtime, credential directory or Tailnet identity is mounted.

Observed results:

| Check | Result |
| --- | --- |
| Initial real daemon | ready; `真实 Pi · 未配置`; `setupRequired: true` |
| Normal RPC writes | created and updated one synthetic bot, ID `e0be68c1-390b-4320-aceb-b53720707e9c` |
| Missing-model send | rejected with `setupRequired`, `retryable: false`, and explicit instruction to configure a model in Settings |
| Conversation safety | zero turns accepted; no guard bypass or fabricated chat/session record |
| First stop | exited, code 0 |
| Restart on same volume | new daemon startedAt; same bot ID and description, plus synthetic workspace file preserved |
| Repeated missing-model send | same explicit rejection; zero turns, tokens and cost |
| Final stop | exited, code 0 |
| Persistent data samples | 580 KiB after write; 408 KiB after restart/verify (SQLite checkpoint changes allocated size) |
| Final stopped volume | Docker reports 250.1 kB; local evidence directory occupies 20 KiB |

Full executed Docker commands (shell-quoted, no credentials), per-command exit/stdout/stderr, and assertions are retained locally:

- `/tmp/pibo-harness-persistence-evidence-20261027/commands.sh`
- `/tmp/pibo-harness-persistence-evidence-20261027/execution.jsonl`
- `/tmp/pibo-harness-persistence-evidence-20261027/result.json` (`complete: true`)

The probe uses only this QA runtime's generated local transport token in memory; no token is printed or written to those evidence files. Names retained for inspection: stopped runtime container `pibo-harness-persistence-qa-20261027`, stopped init container `pibo-harness-persistence-qa-20261027-init`, and volume `pibo-harness-persistence-qa-20261027-data`. The test does not delete containers, data or images.

A final bounded restart of that same QA container also executed the exact
`container/harness-health.mjs` contents through `docker exec -i ... node
--input-type=module`. Its SHA-256 was
`9119718eb2f7d37bccbacf4a13023a2d4f2c0fefb80118edca9193f0c2c9c844`;
it returned exit 0 and `Harness ready (provider configuration is a separate
check)`. The container was stopped again and exited 0. The QA label, no-network
mode and empty published ports were checked before that restart. A compact
copy of these non-secret assertions is committed in
[Docker persistence evidence](harness-docker-persistence-evidence.json).

This verifies the real deployment entrypoint, missing-model guard and small-data persistence using cached dependencies. It **does not** establish that `container/Dockerfile.harness` builds successfully. That clean image build, remote authentication and real model execution remain unperformed; the build is deferred for the documented host-space shortfall.
