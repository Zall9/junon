# Releasing, and how anyone learns there is a release

A plugin installed from a zip has no update path. The IDE does not know where the file came from, so
it can never say a newer one exists — and neither can anything else here, since this product makes no
outbound network calls by design. Until this document existed, the honest answer to "how will users
know there is an update" was: they will not.

Three mechanisms cover it, and only the second needs anything built.

## 1. One version, declared once

`VERSION` at the repository root is the number. Everything else copies it — Gradle, six
`package.json` files, `pyproject.toml`, a Kotlin constant — because each build system wants it in its
own file, and each copy is held by a test that fails when it drifts:

| Stack | Guard |
| --- | --- |
| TypeScript | `packages/bridge-daemon/tests/metadata.test.ts` |
| Kotlin | `jetbrains-plugin/.../service/PluginVersionTest.kt` |
| Python | `integrations/serena/tests/test_version_identity.py` |

They also refuse a version an IDE cannot order. `0.1.0-SNAPSHOT` is what this plugin built as for
months, and a suffix like that makes "is there a newer one" unanswerable — the JetBrains update
mechanism decides by comparing these strings.

To cut a release: edit `VERSION`, run the three suites, and fix whatever the guards name.

## 2. A custom plugin repository — the update notification itself

The JetBrains platform will poll a static XML and show its usual update badge for a plugin that was
never on the Marketplace. Generate it from the built artefact:

```bash
cd jetbrains-plugin && ./gradlew buildPlugin
node scripts/make-update-repository.ts          # → build/updatePlugins.xml
```

It reads `VERSION`, `pluginSinceBuild` and the zip itself, and **refuses** to describe an artefact
that is not there — a repository file that disagrees with its zip is worse than none, because the
IDE offers an update, downloads it, and installs something other than what was advertised.

**What this repository actually does**, since the obvious route was not available: `gh` is not
installed here and creating a release or uploading an asset goes through the API, while git over SSH
works. So the artefact and the XML are committed under `dist/` and served by
raw.githubusercontent.com from `main`:

```
https://raw.githubusercontent.com/Zall9/junon/main/dist/updatePlugins.xml
```

The URL is stable across releases, and an XML an IDE cached earlier still resolves because the zip
keeps its version in its filename. The cost, stated rather than discovered later: **a megabyte per
release stays in git history.** Installing `gh` and switching to real releases would remove that, and
nothing else about the mechanism would change.

A user then adds that URL **once**:

> Settings → Plugins → ⚙ → Manage Plugin Repositories → `+`

**The advertised version must be higher than the installed one**, or there is no badge and nothing is
broken — which is how 0.2.0 became invisible here: it was installed by hand before it was published,
so 0.2.1 is the first release these IDEs can be offered.

From then on the IDE checks it, badges the update, and installs it. Nothing in the plugin reaches the
network, and the daemon — which holds the token — is not involved at all.

The other two halves do not share this mechanism:

- **VS Code**: a `.vsix` installed from a file has no update path whatsoever. It needs Open VSX or
  the Marketplace, or nothing.
- **JUNON**: install from the git URL rather than a local path, and `pipx upgrade` re-fetches:
  ```bash
  pipx install "git+https://github.com/Zall9/junon@main#subdirectory=integrations/serena" --include-apps
  ```

## 3. What no channel can see: the halves drifting apart

The Marketplace will update a plugin without knowing a daemon exists. `pipx` will update JUNON
without knowing either. Each channel sees one half, and the failure that actually bites is the two
halves ending up in different releases — which is what happened here between a Serena 1.7 config
schema and a 1.5.3 install, and again between a registry that gained a field and a plugin that had
not.

The daemon is the only process that sees every peer, and it already receives each one's declared
version. `doctor` now compares them:

```
warn  versions   daemon-0.0.0-older-than-adapter: PS-253.32098.40@0.1.0, IC-252.23892.409@0.1.0
```

That was the first run of the check on this machine, and it was correct: a daemon started days
earlier from an older build, serving five adapters that had been rebuilt since. The peers are named
rather than counted, because a plugin is installed per IDE and the reader has to know which one to
reinstall.

A mismatch **warns**; it does not fail. A peer one release behind usually works, and the handshake
already refuses the case where it genuinely cannot. What it must not do is stay quiet.
