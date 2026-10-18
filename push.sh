#!/usr/bin/env bash
# ============================================================================
#  一键发布到 GitHub —— 只提交关键文件，演示页与测试脚本留在本地
#
#  用法：
#    ./push.sh                   提交并推送
#    ./push.sh -n                预演：只打印将要提交的变更，不动仓库
#    ./push.sh -m "fix: 修 bug"  自定义提交信息
#    ./push.sh --with-tests      连测试脚本一起发布
#    ./push.sh --sync            推送前先与远端 rebase 同步
#    ./push.sh --remote <url>    临时指定仓库地址
#    ./push.sh --allow-key       跳过 32 位 Key 泄露检查（慎用）
#
#  环境变量覆盖：ALC_REPO_URL / ALC_BRANCH
# ============================================================================
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

REPO_URL="${ALC_REPO_URL:-https://github.com/lonyii/ha-amap-scout-card.git}"
BRANCH="${ALC_BRANCH:-main}"

MSG=""
DRY_RUN=0
WITH_TESTS=0
SYNC=0
ALLOW_KEY=0

while [ $# -gt 0 ]; do
  case "$1" in
    -n|--dry-run)   DRY_RUN=1 ;;
    -m|--message)   MSG="${2:-}"; shift ;;
    --with-tests)   WITH_TESTS=1 ;;
    --sync)         SYNC=1 ;;
    --remote)       REPO_URL="${2:-}"; shift ;;
    --allow-key)    ALLOW_KEY=1 ;;
    -h|--help)      sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "未知参数：$1（-h 查看用法）" >&2; exit 2 ;;
  esac
  shift
done

c_info(){ printf '\033[36m›\033[0m %s\n' "$*"; }
c_ok(){   printf '\033[32m✓\033[0m %s\n' "$*"; }
c_warn(){ printf '\033[33m!\033[0m %s\n' "$*"; }
c_die(){  printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 0. 前置检查
[ -f amap-location-card.js ] || c_die "当前目录没有 amap-location-card.js，请在卡片目录里运行"
command -v git >/dev/null 2>&1 || c_die "找不到 git，请先安装 Git for Windows"

c_info "语法检查 amap-location-card.js"
if command -v node >/dev/null 2>&1; then
  node --check amap-location-card.js || c_die "语法有误，已中止（先修好再发）"
  c_ok "语法通过"
else
  c_warn "未找到 node，跳过语法检查"
fi

# ------------------------------------------------------------ 1. 发布白名单
FILES=(amap-location-card.js ha-amap-scout.js README.md hacs.json package.json .gitignore .gitattributes LICENSE push.sh push.cmd)
DIRS=(.github)
if [ "$WITH_TESTS" = 1 ]; then
  FILES+=(.smoke-test.cjs .dom-test.cjs .demo-check.cjs .geo-audit.cjs)
fi

# --------------------------------------------- 2. .gitignore：把本地文件挡在外面
[ -f .gitignore ] || printf 'node_modules/\n' > .gitignore

# push.cmd 一旦被编辑器存成 LF，双击就会报 'ows' / '~dp0"' 这类错 —— 每次顺手修回来
if [ -f push.cmd ] && ! grep -q $'\r' push.cmd 2>/dev/null; then
  sed -i 's/$/\r/' push.cmd
  c_info "已把 push.cmd 转回 CRLF（cmd.exe 的硬要求）"
fi
add_ignore() { grep -qxF "$1" .gitignore 2>/dev/null || printf '%s\n' "$1" >> .gitignore; }
if ! grep -q '本地文件' .gitignore 2>/dev/null; then
  printf '\n# ---- 本地文件（不发布）----\n' >> .gitignore
  printf '# 演示页内含本地调试用的高德 Key，绝不外发\n' >> .gitignore
fi
add_ignore 'demo.html'
if [ "$WITH_TESTS" = 0 ]; then
  for f in .smoke-test.cjs .dom-test.cjs .demo-check.cjs .geo-audit.cjs; do add_ignore "$f"; done
fi
add_ignore '*.png'
add_ignore '*.log'

# --------------------------------------------------------------- 3. 初始化仓库
if [ ! -d .git ]; then
  c_info "初始化本地仓库（分支 $BRANCH）"
  git init -q -b "$BRANCH" 2>/dev/null || { git init -q; git symbolic-ref HEAD "refs/heads/$BRANCH"; }
fi

# 关掉 CRLF 自动转换：避免 Windows 下满屏 "LF will be replaced by CRLF" 警告，
# 也让仓库里的换行与本地一致（HA 直接加载 js，不需要转成 CRLF）
git config core.autocrlf false
git config core.quotepath false

if git remote get-url origin >/dev/null 2>&1; then
  cur=$(git remote get-url origin)
  same=0
  if [ "$cur" = "$REPO_URL" ]; then
    same=1
  elif [ -d "$cur" ] && [ -d "$REPO_URL" ]; then
    # 本地路径型 remote：两种写法（/tmp/x 与 C:/.../x）指向同一目录时不要误报
    a=$(cd "$cur" && pwd 2>/dev/null || true)
    b=$(cd "$REPO_URL" && pwd 2>/dev/null || true)
    [ -n "$a" ] && [ "$a" = "$b" ] && same=1
  fi
  if [ "$same" = 0 ]; then
    c_warn "origin 原本指向 $cur，改为 $REPO_URL"
    git remote set-url origin "$REPO_URL"
  fi
else
  git remote add origin "$REPO_URL"
fi

# ------------------------------------------------- 4. 接上远端历史 / 自动同步
if git fetch -q origin "$BRANCH" 2>/dev/null; then
  if ! git rev-parse --verify -q HEAD >/dev/null; then
    # 本地还没有提交：直接以远端历史为基线，避免 unrelated histories
    git reset -q --mixed FETCH_HEAD
    c_info "已接上远端 $BRANCH 的历史"
  elif ! git merge-base --is-ancestor FETCH_HEAD HEAD 2>/dev/null; then
    if [ "$SYNC" = 1 ]; then
      c_info "与远端同步中…"
      git -c rebase.autoStash=true rebase -q FETCH_HEAD || c_die "rebase 冲突，请手动解决后重跑"
      c_ok "已同步远端提交"
    else
      c_warn "远端有本地没有的提交，推送可能被拒；加 --sync 可自动 rebase"
    fi
  fi
else
  if git ls-remote --heads origin >/dev/null 2>&1; then
    if [ -z "$(git ls-remote --heads origin 2>/dev/null)" ]; then
      c_info "远端是空仓库 → 首次发布"
    elif ! git ls-remote --heads origin 2>/dev/null | grep -q "refs/heads/$BRANCH$"; then
      c_warn "远端没有 $BRANCH 分支，将新建"
    else
      c_warn "远端已有 $BRANCH，但拉取失败；推送时会再试一次"
    fi
  else
    c_warn "连不上远端（网络或凭据），按本地历史提交；推送时会再试一次"
  fi
fi

# --------------------------------- 5. 若曾被误跟踪，把 demo / 测试移出版本库
for f in demo.html .smoke-test.cjs .dom-test.cjs .demo-check.cjs .geo-audit.cjs; do
  if [ "$WITH_TESTS" = 1 ] && [ "$f" != "demo.html" ]; then continue; fi
  if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    c_warn "$f 之前在版本库里 → 移出（本地文件保留）"
    git rm --cached -q "$f"
  fi
done

# --------------------------------------------------------------- 6. 暂存白名单
for f in "${FILES[@]}"; do [ -f "$f" ] && git add -- "$f"; done
for d in "${DIRS[@]}";   do [ -d "$d" ] && git add -A -- "$d"; done

# ---------------------------------------------------- 7. 提交前拦 Key 泄露
if [ "$ALLOW_KEY" = 0 ]; then
  leak=$(git diff --cached -U0 2>/dev/null | grep -E '^\+' | grep -nE '[0-9a-fA-F]{32}' || true)
  if [ -n "$leak" ]; then
    c_warn "待提交内容里出现疑似 32 位高德 Key："
    printf '%s\n' "$leak" | sed -E 's/[0-9a-fA-F]{32}/<已隐藏>/g' | head -5
    git reset -q   # 撤掉暂存，避免带 Key 的版本残留在索引里
    c_die "已中止，避免公开 Key（确认无害可加 --allow-key）"
  fi
fi

# ------------------------------------------------------------- 8. 有无变更
if git diff --cached --quiet; then
  c_ok "没有需要提交的变更（工作区已是最新）"
  exit 0
fi

c_info "将要提交的变更："
git diff --cached --stat | sed 's/^/    /'

if [ "$DRY_RUN" = 1 ]; then
  c_ok "预演结束（未提交）。去掉 -n 即真正提交"
  exit 0
fi

# ------------------------------------------------------------- 9. 提交并推送
[ -n "$MSG" ] || MSG="chore: 更新卡片与文档（$(date '+%Y-%m-%d %H:%M')）"
git commit -q -m "$MSG" || c_die "提交失败"
c_ok "已提交：$(git log -1 --format='%h %s')"

c_info "推送到 $REPO_URL ($BRANCH)"
if git push -q -u origin "$BRANCH" 2>/tmp/alc-push.err; then
  c_ok "推送成功"
  echo
  echo "  仓库：https://github.com/lonyii/ha-amap-scout-card"
  echo "  提交：$(git log -1 --format='%h %s (%cr)')"
  echo
  echo "  HACS 安装：HACS → 前端 → 自定义仓库 → 填入上面的仓库地址 → 类型选「Lovelace」"
else
  echo
  sed 's/^/    /' /tmp/alc-push.err | head -12
  c_die "推送失败：多半是凭据或远端有新提交。可试试 ./push.sh --sync；首次推送会弹 Git 凭据窗口"
fi
