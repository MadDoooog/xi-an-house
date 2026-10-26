#!/usr/bin/env bash
# 打包可加载的扩展成 zip（解压到 D:\ 后目录里直接是 manifest.json）
# 用法：bash scripts/pack_extension.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/extension/app"
OUT_DIR="$ROOT/dist"
NAME="xian-commute-ext"
VER="$(python3 -c "import json,sys;print(json.load(open('$APP/manifest.json'))['version'])")"
ZIP="$OUT_DIR/${NAME}-v${VER}.zip"

if [ ! -f "$APP/manifest.json" ]; then
  echo "找不到 $APP/manifest.json" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
rm -f "$ZIP"

# 先在临时目录里套一层文件夹，这样解压到 D:\ 会得到 D:\xian-commute-ext\
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/$NAME"
cp -R "$APP"/. "$STAGE/$NAME"/
# 去掉开发期噪音
find "$STAGE/$NAME" -name '.DS_Store' -delete 2>/dev/null || true
find "$STAGE/$NAME" -name '*.map' -delete 2>/dev/null || true

( cd "$STAGE" && python3 - "$ZIP" "$NAME" <<'PY'
import os, sys, zipfile

zip_path, top = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
    for root, _dirs, files in os.walk(top):
        for f in sorted(files):
            full = os.path.join(root, f)
            z.write(full, os.path.relpath(full, "."))
print("zipped", zip_path)
PY
)

echo "已生成：$ZIP"
echo "--- 包内清单 ---"
python3 - "$ZIP" <<'PY'
import sys, zipfile

with zipfile.ZipFile(sys.argv[1]) as z:
    for info in z.infolist()[:40]:
        print(f"{info.file_size:>9}  {info.filename}")
PY
echo
echo "Windows 上解压到 D:\\ 之后，应存在：D:\\${NAME}\\manifest.json"
