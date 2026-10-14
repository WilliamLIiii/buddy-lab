#!/bin/sh
set -eu
cd "$(dirname "$0")"
runtime="${BUDDYLAB_NODE_BIN:-node}"
if ! "$runtime" -e 'try { const [major,minor]=process.versions.node.split(".").map(Number); if(major<22 || (major===22 && minor<13)) throw Error(); require("node:sqlite"); } catch {process.exit(1)}' 2>/dev/null; then
  if [ -x /opt/homebrew/opt/node@22/bin/node ]; then
    runtime=/opt/homebrew/opt/node@22/bin/node
  else
    echo 'BuddyLab 需要 Node.js 22.13 或更新版本。可用 BUDDYLAB_NODE_BIN 指定已安装的运行时。' >&2
    exit 1
  fi
fi
if [ "$#" -gt 0 ]; then
  exec "$runtime" "$@"
fi
exec "$runtime" src/server.mjs
