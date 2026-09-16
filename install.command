#!/bin/sh
# Fairy-DSH 一键安装/部署（macOS 双击入口；Linux 用 ./install.sh）。
# macOS 的 Finder 只对 .command 双击执行，所以这里单独放一个转调 install.sh。
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
exec "$HERE/install.sh" "$@"
