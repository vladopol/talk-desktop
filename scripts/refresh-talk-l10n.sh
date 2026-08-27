#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Vladimir Poluliashenko
# SPDX-License-Identifier: AGPL-3.0-or-later

# Takes the translations of the built-in Talk from upstream.
#
# The spreed branch of the fork sits on a release tag, but translations keep
# arriving in the branch that tag was cut from for months afterwards. Nothing in
# this fork translates anything of the built-in Talk, so there is nothing to
# merge: replace l10n/ with upstream's, and hand-written strings never have to
# compete with the ones Transifex delivers later.
#
# Usage: scripts/refresh-talk-l10n.sh [path-to-spreed] [upstream-ref]

set -euo pipefail

talk_dir="${1:-spreed}"
upstream_ref="${2:-stable34}"
upstream_repo="https://github.com/nextcloud/spreed.git"

cd "$talk_dir"

git fetch --no-tags --depth=1 "$upstream_repo" "$upstream_ref"
git checkout FETCH_HEAD -- l10n

echo "Translations taken from nextcloud/spreed $upstream_ref ($(git rev-parse FETCH_HEAD))"
git --no-pager diff --stat HEAD -- l10n | tail -n 3
