#!/bin/zsh
# Make every JetBrains IDE on this machine poll the IDE Bridge plugin repository, without clicking.
#
# Two mechanisms are written, on purpose, because they fail differently.
#
#   idea.properties → idea.plugin.hosts    Read at start-up by `RepositoryHelper` (confirmed in the
#                                          platform's own class). The IDE never rewrites this file,
#                                          so the value cannot be lost — which matters, because the
#                                          settings route can be.
#   options/updates.xml → pluginHosts      What the *Manage Plugin Repositories* dialog writes. Held
#                                          in memory by a running IDE, which rewrites the file when
#                                          it saves: an edit made while the IDE runs is discarded on
#                                          exit. Written anyway, so the dialog shows the entry.
#
# Both take effect at the IDE's next start. An IDE below the plugin's since-build is skipped: adding
# a repository it can never install from would only add a poll.
#
# Usage: scripts/ensure-plugin-repository.sh [URL]

set -e
URL=${1:-https://raw.githubusercontent.com/Zall9/junon/main/dist/updatePlugins.xml}
BASE=~/Library/Application\ Support/JetBrains
SINCE=$(grep '^pluginSinceBuild=' "${0:A:h}/../jetbrains-plugin/gradle.properties" | cut -d= -f2)

echo "repository : $URL"
echo "since-build: $SINCE"

for dir in $BASE/*(N/); do
  ide=${dir:t}
  # A config directory is named <Product><year>.<n>; the build line is what decides eligibility.
  branch=$(echo $ide | sed -nE 's/^[A-Za-z]+([0-9]{4})\.([0-9]+)$/\1\2/p')
  [ -z "$branch" ] && continue
  # 2025.2 -> 252, 2026.1 -> 261: the platform's branch number is (year-2000)*10 + release.
  year=${branch:0:4}; release=${branch:4}
  build=$(( (year - 2000) * 10 + release ))
  if [ "$build" -lt "$SINCE" ]; then
    printf "  %-20s skipped — build %s < %s\n" "$ide" "$build" "$SINCE"
    continue
  fi

  props=$dir/idea.properties
  if [ -f "$props" ] && grep -q "^idea.plugin.hosts=" "$props"; then
    if grep -q "^idea.plugin.hosts=.*$URL" "$props"; then
      state="already set"
    else
      # Appended to the existing list rather than replacing it: another repository may be there.
      sed -i '' "s|^idea.plugin.hosts=\(.*\)$|idea.plugin.hosts=\1;$URL|" "$props"
      state="added to the existing list"
    fi
  else
    [ -f "$props" ] || printf '# custom properties (expand/override bin/idea.properties)\n' > "$props"
    printf '\n# IDE Bridge plugin repository — read at start-up, immune to settings rewrites.\nidea.plugin.hosts=%s\n' "$URL" >> "$props"
    state="written"
  fi
  printf "  %-20s build %-4s %s\n" "$ide" "$build" "$state"
done
