# DSH Upgrade Compatibility Matrix

This document defines a read-only gate for an official DSH candidate. It does
not authorize an install, lockfile refresh, package change, or runtime patch.

## Reviewed Baseline

| Surface | Declaration / resolved version | Upgrade contract |
| --- | --- | --- |
| Official browser runtime | `0.1.1-rc.2`, SHA-256 `13a5fe0ee8cddda2306d302eb0dbfdd601e96d14baeb512867b4b6d1d72f6679` | Browser ModuleLoader registration, `factory(require)`, client lifecycle and slots remain present. |
| Fairy Visual host settings | `@deepseek-ai/dsh-settings` exactly `0.1.1-rc.2` | The host alone imports `settingsNamespace` and registers its schema through `ctx.inject(['settings'])` / `settings.register`. |
| Fairy Visual client settings | Official runtime `0.1.1-rc.2` | The client uses `ctx.settingsScope.bind`; it must not import or bundle `@deepseek-ai/dsh-settings`. |
| `dsh-reasoning-effort` | `github:HanaAyane/dsh-reasoning-effort#main`, resolved lock version `0.6.2` | The current lock pin is commit `83bc8c548749d7156a03d11d875d8117e9b5d994` plus patch hash `9cbcceae243982ca0241cd41471317da9112c3e61e345b3b32f205d90aec18b5`. |
| `dsh-message-edit` | exact `0.2.3` | The current lock patch hash is `2ff69549d829fc326b1f34b2d2d869e5680e784bcbc45304ff431776bfc29c6c`. |

## Peer API Risks

`dsh-reasoning-effort` declares `^0.1.0-rc.6` peer ranges for the browser
runtime, connection, conversation, model-selection, settings, slots, remotes,
and Cordis. The installed official providers are `0.1.1-rc.2`; semver range
acceptance is not evidence that its ModuleLoader bundle, `conversation.input.model`,
or `settings.general.item` slots remain compatible.

`dsh-message-edit` declares no runtime peer dependencies. Its bundle was built
against rc.6 development dependencies and implicitly relies on the browser
ModuleLoader plus `conversation.view` and `conversation.session.header.actions`.
Treat those as peer API contracts even though its manifest does not state them.

## Upgrade Blockers

Do not upgrade until a candidate preserves, or has an explicitly reviewed
replacement for, all of the following:

- approved runtime version and SHA-256;
- ModuleLoader boot protocol and lifecycle/slot behavior;
- Visual settings import boundary, resolved version, `settings.register`, and
  client `settingsScope` bridge;
- Visual slots, DOM attributes/selectors, and Chinese ARIA anchors;
- reasoning peer ranges, slots, source commit, and patch hash;
- message-edit version, bundled ModuleLoader/slot contract, and patch hash.

The reasoning declaration points to a moving Git branch. The lockfile commit
and patch hash are therefore the actual reproducibility pins. A lockfile diff
for either third-party plugin is a blocking review item, not routine upgrade
noise.

## Read-only Commands

```sh
cd <fairy-dsh-checkout>
node fairy-system/upgrade-preflight.js --report
node fairy-system/upgrade-preflight.js \
  --profile /absolute/isolated/profile \
  --runtime /absolute/isolated/runtime/lib/client.js \
  --expected-version 0.1.1-rc.2 \
  --expected-sha256 13a5fe0ee8cddda2306d302eb0dbfdd601e96d14baeb512867b4b6d1d72f6679
```

## 2026-08-25 capability boundary

- The official DOM selector, attribute, slot, ARIA, Session, and Workspace
  contracts are versioned in `capability-matrix.json`.
- Fairy Visual's official DOM selectors are resolved through
  `fairy-visual/dsh-fairy-visual/src/client/dom-adapter.js`; observer helpers
  consume adapter exports instead of duplicating official selectors.
- The approved Visual settings dependency is
  `@deepseek-ai/dsh-settings@0.1.1-rc.2`, aligned with the installed DSH
  runtime family.
- `upgrade-preflight.js` rejects the active profile/runtime by default and
  validates only an explicitly supplied isolated candidate pair.
- Browser evidence is required for normal/HDD, Light/Dark, historical-session,
  composer-replacement, sidebar-transition, and console-error cases before a
  new runtime can be approved.

## 2026-09-17 dual-line home isolation

Two base lines must not share one DSH home. `<home>/profiles/node_modules` is
the module fallback farm, owned and maintained by the harness, never by pnpm:
at every boot `healProfilesModuleFallback` (`dsh-app-boot`) walks the booting
installation's dependency closure and writes one junction link per package,
keeping correct links, re-pointing moved installations (a link whose target
differs is unlinked and recreated), and leaving entries outside that closure
alone. One farm holds one link per name, so the line that booted last owns every
shared package and decides the other line's next cold boot. Failure modes
observed that day, all traced to one shared home:

- 0.1.1 boot crash `WorkspaceRegistry.indexHeader ... reading 'id'`: the farm
  entry `@deepseek-ai/dsh-workspace` was left pointing at the 0.1.6 global
  installation, so the 0.1.1 boot loaded 0.1.6 workspace code.
- 0.1.6 boot crash `Package subpath './model-selection-settings' is not defined`:
  the same farm resolved `@deepseek-ai/dsh-tool-subagent` to a 0.1.1 copy, so
  `dsh-web-app`'s row could not import.
- 0.1.6 client `Failed to load plugins ... import failed`: client modules are
  resolved through the farm at request time, so flipping the farm breaks asset
  delivery on an already-running server.
- `WEB_DUPLICATE_PROVIDER` (`web provider with id "http" is already registered`)
  on 0.1.6: the launch was missing `DSH_FAIRY_BASE`, so `cordis.patch.yml` kept
  the `fairy-web-fetch-http` row enabled that 0.1.5+ must disable.

Rules:

- One base line per home: `.dsh-test-home` is 0.1.1, `.dsh-test-home-015` and
  `.dsh-test-home-016` are their own lines. Deploy with
  `scripts/deploy-live.sh --home <home>`.
- Start through the generated launcher or replicate its full environment:
  `DSH_HOME`, `DSH_FAIRY_BASE`, `DSH_FAIRY_REPO_ROOT`, `DSH_FAIRY_TEST_HOME`,
  `DSH_FAIRY_PROFILE_ROOT`. Missing `DSH_FAIRY_BASE` faults loudly by design;
  missing `DSH_HOME` silently falls back to `~/.dsh` and boots the wrong profile.
- Never run `pnpm install` by hand inside a home, and never hand-edit the farm.
  The farm is harness-owned; pnpm only manages each profile's own
  `node_modules` and each staged package's tree. A non-dsh writer that puts a
  real directory at a farm entry path makes the next boot's heal throw
  `exists and is not a symlink; remove it so dsh can manage the installation
  fallback` — junctions are fine (the heal itself creates
  `symlinkSync(target, link, "junction")` and accepts them via
  `lstatSync(link).isSymbolicLink()`). Recovering a poisoned home means fixing
  that one entry or re-pointing links for the intended line, not reinstalling
  the profile ad hoc.
