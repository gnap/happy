#!/bin/sh
# 安装 pre-commit 钩子：提交前自动构建 happy-coder，确保无错误再提交

set -e
ROOT="$(git rev-parse --show-toplevel)"
cp "$ROOT/scripts/pre-commit.hook" "$ROOT/.git/hooks/pre-commit"
chmod +x "$ROOT/.git/hooks/pre-commit"
echo "Installed .git/hooks/pre-commit (build happy-coder before commit when packages/happy-cli is staged)."
