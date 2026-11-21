#!/bin/sh
# Install dsh-chat-switch into the on-device DSHM profile as a bundle plugin.
#
#   sh install.sh [profile-dir]
#
# A DSHM profile rebuilds its cordis.patch.yml from "seed bundles + user rows" on
# every start, so a hand-written mount line there is discarded. The durable
# channel is the profile's own package.json:
#   · dsh.profile.bundles  → the bundle patch layer that mounts the plugin row
#   · dependencies         → so the settings ▸ Plugins list shows it with its
#                            name, version, icon, toggle and uninstall button
# A DSHM restart is required (patchReload: startup).
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROFILE=${1:-${DSH_HOME:-/data/storage/el2/base/haps/phone/files/dsh/home}/profiles/ondevice}
PKG="$PROFILE/node_modules/dsh-chat-switch"

[ -f "$PROFILE/package.json" ] || { echo "not a dsh profile: $PROFILE" >&2; exit 1; }

mkdir -p "$PKG"
for file in package.json cordis.patch.yml icon.svg README.md LICENSE; do
  [ -f "$HERE/$file" ] && cp -f "$HERE/$file" "$PKG/$file"
done
rm -rf "$PKG/lib" "$PKG/src" "$PKG/assets" "$PKG/docs"
cp -R "$HERE/lib" "$PKG/lib"
cp -R "$HERE/src" "$PKG/src"
cp -R "$HERE/assets" "$PKG/assets"
cp -R "$HERE/docs" "$PKG/docs"

python3 - "$PROFILE/package.json" "$PKG/package.json" <<'PY'
import io, json, sys
profile_path, pkg_path = sys.argv[1], sys.argv[2]
manifest = json.loads(io.open(pkg_path, encoding='utf-8').read())
name = manifest['name']
version = manifest.get('version', '0.0.0')

data = json.loads(io.open(profile_path, encoding='utf-8').read())
# dependencies: what the settings ▸ Plugins list enumerates
data.setdefault('dependencies', {})[name] = version
profile = data.setdefault('dsh', {}).setdefault('profile', {})
bundles = profile.setdefault('bundles', [])
if name not in bundles:
    bundles.append(name)
io.open(profile_path, 'w', encoding='utf-8').write(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
print('profile package.json: dependencies[' + name + '] = ' + version + ', bundles updated')
PY

# The DSHM app process owns the profile directory; a root-run copy must hand
# the tree back, otherwise the Host cannot read the plugin at startup.
OWNER=$(ls -nd "$PROFILE" 2>/dev/null | awk '{print $3":"$4}')
if [ "$(id -u)" = "0" ] && [ -n "$OWNER" ]; then
  chown -R "$OWNER" "$PKG" 2>/dev/null || true
  chown "$OWNER" "$PROFILE/package.json" 2>/dev/null || true
fi
chmod -R a+rX "$PKG"

echo "installed: $PKG"
echo "restart DSHM: the plugin appears under Settings ▸ Plugins with its own toggle."
