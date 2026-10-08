# Releasing to npm

Pushing a `v*` tag runs [`.github/workflows/release.yml`](../.github/workflows/release.yml), which tests, builds, and publishes the package to npm.

The workflow uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC). GitHub Actions trades a short-lived identity token for a one-time publish credential, so the repository stores no `NPM_TOKEN` secret. npm attaches [provenance](https://docs.npmjs.com/generating-provenance-statements) automatically, because the repository and the package are both public.

## One-time setup

### 1. Add the trusted publisher on npmjs.com

Open **npmjs.com → mcp-accessibility-scanner → Settings → Trusted publishing** and add a GitHub Actions publisher:

| Field | Value |
| --- | --- |
| Organization or user | `JustasMonkev` |
| Repository | `mcp-accessibility-scanner` |
| Workflow filename | `release.yml` |
| Environment name | `npm` |
| Allowed actions | enable `npm publish` |

All fields are case-sensitive, and npm does not check them when you save. A mistake shows up only as a failed publish.

- **Allowed actions:** `npm stage publish` is always allowed, but `npm publish` must be enabled explicitly. If it is off, the publish step fails with an authorization error. To make every release wait for a maintainer's 2FA approval instead, see [Staged publishing](#staged-publishing-optional).
- **2-day window:** a new trusted publisher configuration expires if it has not completed a successful publish within 2 days. An expired configuration cannot be used or edited. Delete it, create a new one, and release within 2 days. Add the publisher shortly before the first tagged release.
- **`repository.url`:** `repository.url` in `package.json` must match this GitHub repository exactly. It already does. Forks must change it to their own repository.

### 2. Create the `npm` environment on GitHub (optional protection)

The publish job runs in the `npm` [deployment environment](https://docs.github.com/actions/deployment/targeting-different-environments/using-environments-for-deployment). GitHub creates the environment on the first run if it does not exist. In **Settings → Environments → npm** you can add:

- **Deployment tags:** allow only tags matching `v*`.
- **Required reviewers:** a person must approve each publish before it runs.

The trusted publisher above names this environment, so npm rejects publish tokens from any other job or environment.

### 3. Lock down token publishing

After the first successful trusted publish, open **Settings → Publishing access** on npmjs.com. Select **Require two-factor authentication and disallow tokens**. Trusted publishing keeps working, and a leaked classic or granular token can no longer publish. Revoke any old automation tokens that were used for publishing.

## Cutting a release

1. Open a pull request that bumps the version:

   ```bash
   npm version 4.0.1 --no-git-tag-version   # updates package.json and package-lock.json
   ```

   Also set `version` and `packages[0].version` in `server.json` to the same version. That file is the MCP Registry entry.

2. Merge the pull request into `main` after CI passes.

3. Tag the merge commit on `main` and push the tag:

   ```bash
   git fetch origin main
   git tag v4.0.1 origin/main
   git push origin v4.0.1
   ```

4. Follow the **Release** run under the repository's Actions tab. When it finishes, check the version and the provenance badge on npmjs.com:

   ```bash
   npm view mcp-accessibility-scanner version
   npm audit signatures   # run in a project that depends on the package
   ```

### What the workflow checks before publishing

- The tag points at a commit already on `main`.
- The tag equals `v` + `package.json` `version`. Pushing `v4.0.1` while `package.json` says `4.0.0` fails.
- That version is not yet on npm, and it is newer than the version the target dist-tag (`latest` or `next`) points at. Publishing passes `--tag` explicitly, which skips npm's own lower-version check, so without this an older tag would move `latest` or `next` backward.
- `npm ci` passes under npm 12 with `strict-allow-scripts`. Any dependency install script not approved in `allowScripts` fails the release (see below).
- Lint, typecheck, unit tests, and a clean build pass. `npm pack --dry-run` lists the tarball contents in the log.

### Prereleases

A version with a prerelease suffix, such as `4.1.0-beta.1` tagged `v4.1.0-beta.1`, is published under the `next` dist-tag. `latest` keeps pointing at the last stable release. Users install a prerelease with `npm install mcp-accessibility-scanner@next`.

### Re-running a failed release

If the run fails before the publish step, fix the problem on `main`, then move the tag to the fixed commit:

```bash
git fetch origin main                  # pick up the merged fix
git push origin :refs/tags/v4.0.1      # delete the remote tag
git tag -f v4.0.1 origin/main
git push origin v4.0.1
```

If the publish step itself succeeded, the version is final. npm never allows republishing a version, even after unpublishing it. Release a new patch version instead.

## npm 12 rules that affect this package

npm 12 changed several install defaults ([GitHub changelog](https://github.blog/changelog/2026-06-09-upcoming-breaking-changes-for-npm-v12/)). The release job pins npm 12.2.0 so it builds under the same rules users will have.

### Dependency install scripts are opt-in (`allowScripts`)

npm 12 no longer runs dependency `preinstall`, `install`, or `postinstall` scripts, or implicit `node-gyp` builds, unless the project approves them. This repository approves them in the `allowScripts` field of `package.json`:

```json
"allowScripts": {
  "fsevents@2.3.2": true,
  "fsevents@2.3.3": true,
  "re2@1.26.1": true
}
```

The entries are pinned to exact versions. When a dependency update (for example a `re2` bump) changes one of these versions, update the matching entry in the same pull request. Otherwise the release job's strict `npm ci` fails, and a non-strict install would skip the native build. To review and record approvals:

```bash
npm install-scripts ls            # list scripts and their approval state
npm install-scripts approve re2   # approve and pin the resolved version
npm install-scripts deny <pkg>    # deny explicitly
```

Commit the resulting `package.json` change.

### What it means for users

`allowScripts` in this package's own `package.json` applies only inside this repository. When users install the package, their npm 12 does not read it. `re2` is a native addon that downloads or compiles `re2.node` in its install script. Without that script the server cannot start (`Cannot find module './build/Release/re2.node'`). Users on npm 12 must allow it themselves:

```bash
npm install -g mcp-accessibility-scanner --allow-scripts=re2
npx -y --allow-scripts=re2 mcp-accessibility-scanner
```

Older npm versions accept the flag and ignore it. For a project dependency, users run `npm install-scripts approve re2` in their project instead. The README installation section documents this for users.

### Git and remote-URL dependencies are blocked

`allow-git` and `allow-remote` now default to `none`. All dependencies of this package come from the npm registry, so nothing changes here. Keep it that way, because a git or tarball-URL dependency would make the package fail to install for npm 12 users.

### Version requirements

npm 12 requires Node.js `^22.22.2 || ^24.15.0 || >=26.0.0`, and trusted publishing requires npm 11.5.1 or newer. The release job selects Node.js `^24.15.0 || >=26.0.0`, the range in this package's `engines` field, and installs npm 12.2.0.

## Staged publishing (optional)

For a human 2FA approval on every release, switch the publish step in `release.yml` to:

```yaml
run: npm stage publish --tag "$DIST_TAG"
```

Then restrict the trusted publisher to `npm stage publish` only. npm fixes a connection's required fields once it is created, and may not let you change its allowed actions in place either. If the settings page does not offer to turn off `npm publish`, delete the connection and add a new one with the same values from [step 1](#1-add-the-trusted-publisher-on-npmjscom), leaving `npm publish` disabled. The new connection gets its own 2-day window, so release within 2 days of recreating it. CI uploads the version in a non-public state, and a maintainer makes it public with `npm stage approve <stage-id>`, which requires 2FA. `npm stage reject <stage-id>` discards it.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Tag vX does not match package.json version` | Bump `package.json` on `main` first, or tag the right version. |
| `... is already on npm` | That version was already published. Bump to a new version. |
| `... is not newer than the current latest` (or `next`) | The tag is older than what that dist-tag already points at. Bump to a higher version. To publish a backport to an older release line, publish it by hand with a separate dist-tag, for example `npm publish --tag v3-latest`. |
| `is not on main` | The tag points at a branch commit. Tag the merge commit on `main`. |
| `--strict-allow-scripts: ... not covered by allowScripts` | A dependency's install script is new or its version changed. Review it, run `npm install-scripts approve <pkg>` or `deny`, and commit `package.json`. |
| `E404`/`ENEEDAUTH`/`403` on publish | The trusted publisher is missing, expired, or mismatched. Check the owner, repository, `release.yml`, the `npm` environment, and that `npm publish` is allowed. |
| Publish succeeds without provenance | Provenance is generated only when both the repository and the package are public. |
