---
name: release
description: Create a production release — bump version, run tests, generate changelog, tag, merge to prod, and optionally build+upload iOS
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash Read Grep
argument-hint: [patch|minor|major] [--ios] [--dry-run]
---

# Production Release

Create a Brimstone production release. This runs `scripts/release.js` which bumps the version on dev, generates release notes from commits, tags, and fast-forward merges to prod.

## Pre-flight

Before releasing, verify the branch is clean and tests pass:

1. Confirm you are on the `dev` branch with a clean working tree:
   ```!
   git rev-parse --abbrev-ref HEAD
   git status --short
   ```
2. Run the full test suite — do NOT release if tests fail:
   ```bash
   npm test
   ```
3. Show the user what commits will be included in the release:
   ```bash
   git log $(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)..HEAD --oneline
   ```

If the working tree is dirty or tests fail, stop and tell the user. Do not proceed.

## Arguments

Parse `$ARGUMENTS` for these flags (all optional, defaults to `patch`):

| Argument | Description |
|----------|-------------|
| `patch` / `minor` / `major` | Semver bump level (default: `patch`) |
| `--ios` | Also bump iOS MARKETING_VERSION — triggers App Store review. Only use when explicitly requested |
| `--dry-run` | Preview the release without writing anything |

## Release

Run the release script with the parsed arguments:

```bash
node scripts/release.js $ARGUMENTS
```

If the script succeeds, report:
- The new version number
- A summary of the generated release notes
- Whether it was a dry run or a real release
- Remind the user to `git push origin dev prod --tags` to publish

## iOS build (only if `--ios` was passed)

If `--ios` was included, after the release script completes successfully, offer to build and upload to App Store Connect:

```bash
npm run cap:sync:ios:prod
```

Then remind the user they can upload via Xcode or the release script's built-in upload.

## Important

- **Never** pass `--ios` unless the user explicitly asked for it. Changing the iOS marketing version triggers a multi-day App Store review.
- If the release script fails, show the full error output and do not retry automatically.
- Do not push to remote — let the user decide when to push.
