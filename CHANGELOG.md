# Changelog

What changed in each release, and what you have to do about it. Versions follow `VERSION` at the
repository root; every half of the product carries the same number, and a guard in each stack fails
when one drifts (see [AGENTS.md](AGENTS.md) §10).

**Updating**, whichever release you are on:

```bash
scripts/install-jetbrains-plugin.sh    # every JetBrains IDE on the machine, then restart them
pipx upgrade serena-agent              # JUNON, if it was installed from the git URL
pnpm -r build                          # the daemon and the CLI, then restart the daemon
```

Both halves report what they are: `ide-bridge doctor` names any peer that is behind, and `ide_status`
tells the agent — and through it, you.

## 0.2.2

- **The daemon can now be named as the stale half.** Every comparison measured peers _against_ the
  daemon, which made it correct by construction: a 0.2.1 daemon serving 0.2.1 plugins reported
  agreement while the rest of the installation had moved on. Both surfaces gained the reference they
  lacked — JUNON's own version for `ide_status` and the dashboard, this CLI's for `doctor` — and both
  say to rebuild _and restart_, since a rebuild alone changes nothing.

**The update surface people actually see.** 0.2.1 could be announced; this is the release that says so
where you are looking.

- The JUNON dashboard raises a **toast** when the halves are out of step, with an **Install now**
  button. The button is guarded — a token minted per process and sent in a header, an `Origin` check,
  no parameters, and the IDE's own `installPlugins` rather than a shell string — because a page on
  127.0.0.1 that executes is a door.
- It reports what actually changed, not what exited zero: `installPlugins` returns 0 against a running
  IDE and writes nothing, so the plugin version is read off disk before and after. Running IDEs are
  named as such rather than called failures.
- Every answer ends with how to check it took, because an installed plugin is not a loaded one.
- The agent-facing instructions changed shape: an opening move rather than a prohibition, a fallback
  that must be justified in one line, and the reason stated in terms an agent can verify.

## 0.2.1

**The first release an IDE can be told about.** Everything needed for an update notification existed
except a version higher than the one installed and a URL that answers; both are here.

- The plugin repository is published at
  `https://raw.githubusercontent.com/Zall9/junon/main/dist/updatePlugins.xml`. Add it once per IDE —
  or let `scripts/install-jetbrains-plugin.sh` do it — and that IDE can offer future versions itself.
  Verified end to end: `installPlugins com.idebridge.jetbrains` resolved the plugin from that
  repository and installed it into a PyCharm that had never seen it.
- `scripts/ensure-plugin-repository.sh` writes the repository two ways, because they fail
  differently: `idea.properties` → `idea.plugin.hosts`, which the IDE never rewrites, and
  `options/updates.xml` → `pluginHosts`, which a **running** IDE erases from memory on exit — measured
  twice here.
- The JUNON dashboard's **IDE Bridge card** now states whether the halves are the same release, and
  the command to run when they are not — the surface for someone who opens neither a terminal nor an
  agent.
- `ide_status` now reports the version of the daemon and of every connected plugin, with the command
  to run when they differ. Nothing else could say it: an IDE updates its plugin without knowing a
  daemon exists, and `pipx` updates JUNON without knowing either.

**Restart what you update.** A plugin and a repository URL are both read at start-up; an IDE running
at the moment you install has neither.

## 0.2.0

**One version for the whole product, and the machinery to notice a mismatch.** Seven declarations of
the version existed and no two agreed — the daemon said `0.0.0`, the plugin's constant `0.1.0` while
Gradle built `0.1.0-SNAPSHOT`, JUNON sent a literal `0.1.0` from a package calling itself `0.0.0`.
Nothing could be compared, which is why no update signal of any kind was possible.

- `VERSION` at the root is the number; every copy is held by a test.
- `ide-bridge doctor` gains a `versions` check that names the peers that are behind rather than
  counting them, because a plugin is installed per IDE.
- `ide_refactor` — the IDE's own rename, reachable from Serena for the first time. `rename`,
  `reformat` and `optimizeImports` were served by both adapters and reachable by nobody.
- The JetBrains plugin builds on **JDK 21 or newer**; the bytecode stays at 21, because PhpStorm
  2025.3 still runs JBR 21 and refuses anything above.
- The JetBrains tool window says when no JUNON dashboard is running instead of hiding its link.
