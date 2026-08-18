#!/bin/zsh
# Install the JetBrains adapter into every IDE on this machine that can run it, and give each one
# somewhere to look for updates. One command, because doing it by hand is three per IDE and the
# third is the one everybody skips.
#
#   scripts/install-jetbrains-plugin.sh              build, install, configure
#   scripts/install-jetbrains-plugin.sh --dry-run    say what it would do and touch nothing
#
# Installing into a running IDE is safe — plugins are read at start-up, so the IDE simply picks up
# the new jar next time. What is *not* safe is writing settings under a running IDE, which is why the
# repository URL travels by `idea.properties` (see scripts/ensure-plugin-repository.sh).

set -e
HERE=${0:A:h}
REPO=${HERE:h}
DRY=0
[ "$1" = "--dry-run" ] && DRY=1

VERSION=$(cat "$REPO/VERSION")
NAME=$(grep '^pluginName=' "$REPO/jetbrains-plugin/gradle.properties" | cut -d= -f2)
SINCE=$(grep '^pluginSinceBuild=' "$REPO/jetbrains-plugin/gradle.properties" | cut -d= -f2)
ZIP="$REPO/jetbrains-plugin/build/distributions/$NAME-$VERSION.zip"
BASE=~/Library/Application\ Support/JetBrains

echo "plugin      : $NAME $VERSION (since-build $SINCE)"

if [ ! -f "$ZIP" ]; then
  if [ "$DRY" = "1" ]; then
    echo "artefact    : missing — would run ./gradlew buildPlugin"
  else
    echo "artefact    : missing, building"
    (cd "$REPO/jetbrains-plugin" && ./gradlew buildPlugin --console=plain -q)
  fi
else
  echo "artefact    : $(basename "$ZIP")"
fi

installed=()
for dir in $BASE/*(N/); do
  ide=${dir:t}
  branch=$(echo $ide | sed -nE 's/^[A-Za-z]+([0-9]{4})\.([0-9]+)$/\1 \2/p')
  [ -z "$branch" ] && continue
  year=${branch%% *}; release=${branch##* }
  build=$(( (year - 2000) * 10 + release ))
  if [ "$build" -lt "$SINCE" ]; then
    printf "  %-20s skipped — build %s < %s\n" "$ide" "$build" "$SINCE"
    continue
  fi

  target=$dir/plugins/$NAME
  current="none"
  for jar in $target/lib/*.jar(N); do
    current=$(unzip -p "$jar" META-INF/plugin.xml | grep -oE '<version>[^<]+' | sed 's/<version>//')
  done

  if [ "$DRY" = "1" ]; then
    printf "  %-20s build %-4s has %-14s would install %s\n" "$ide" "$build" "$current" "$VERSION"
  else
    rm -rf "$target"
    unzip -q "$ZIP" -d "$dir/plugins"
    printf "  %-20s build %-4s %s -> %s\n" "$ide" "$build" "$current" "$VERSION"
    installed+=$ide
  fi
done

echo
if [ "$DRY" = "1" ]; then
  echo "would then run scripts/ensure-plugin-repository.sh"
else
  zsh "$HERE/ensure-plugin-repository.sh"
  echo
  echo "Restart each IDE once. The plugin is read at start-up, and so is the repository URL — an IDE"
  echo "running now has neither."
fi
