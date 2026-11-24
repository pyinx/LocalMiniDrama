#!/usr/bin/env bash
#
# LocalMiniDrama backend 启停管理脚本
#
# 用法:
#   ./scripts/service.sh start [--watch]    后台启动（日志写入 logs/）；--watch 监听代码变更并自动热加载
#   ./scripts/service.sh stop               停止服务
#   ./scripts/service.sh restart [--watch]  重启
#   ./scripts/service.sh status             查看运行状态
#   ./scripts/service.sh logs               实时跟踪日志（Ctrl+C 退出）
#
# 也可用环境变量 WATCH=1 代替 --watch。热加载基于 node --watch：只监听 server.js 引用到的模块，
# 改动后进程整体重启（进行中的生成任务会中断），所以只建议开发时使用。
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SERVER_JS="${BACKEND_DIR}/src/server.js"
LOG_DIR="${BACKEND_DIR}/logs"
LOG_FILE="${LOG_DIR}/backend.log"
PID_FILE="${BACKEND_DIR}/.backend.pid"
PORT=5679
# 匹配指向本项目 server.js 的 node 进程（无论相对/绝对路径启动，也包括 node --watch）
PROC_PATTERN="node( --watch)? (${BACKEND_DIR}/src/server\.js|src/server\.js)$"
HEALTH_URL="http://127.0.0.1:${PORT}/health"

mkdir -p "${LOG_DIR}"

is_running() {
  [[ -f "${PID_FILE}" ]] || return 1
  local pid
  pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
  [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null
}

# 通过 /health 接口判断后端是否真正在提供服务
# （5679 端口可能被 Vite 开发服务器占用并代理，不能只看端口）
backend_alive() {
  curl -sf --max-time 2 "${HEALTH_URL}" 2>/dev/null | grep -q '"status":"ok"'
}

find_server_pids() {
  pgrep -f "${PROC_PATTERN}" 2>/dev/null || true
}

cmd_start() {
  if backend_alive; then
    echo "后端已在运行（${HEALTH_URL} 正常），如需重启请使用: $0 restart"
    exit 0
  fi
  local stale_pids
  stale_pids="$(find_server_pids)"
  if [[ -n "${stale_pids}" ]]; then
    echo "发现残留的后端进程 (PID: ${stale_pids//$'\n'/ })，先停止它们"
    kill ${stale_pids} 2>/dev/null || true
    sleep 1
    pkill -9 -f "${PROC_PATTERN}" 2>/dev/null || true
  fi
  if is_running; then
    echo "已在运行 (PID $(cat "${PID_FILE}"))，如需重启请使用: $0 restart"
    exit 0
  fi
  rm -f "${PID_FILE}"
  cd "${BACKEND_DIR}"
  if [[ "${WATCH}" == "1" ]]; then
    nohup node --watch "${SERVER_JS}" >>"${LOG_FILE}" 2>&1 &
  else
    nohup node "${SERVER_JS}" >>"${LOG_FILE}" 2>&1 &
  fi
  echo $! > "${PID_FILE}"
  echo "已启动 (PID $(cat "${PID_FILE}"))$([[ "${WATCH}" == "1" ]] && echo '，热加载已开启')，日志: ${LOG_FILE}"
  for _ in {1..20}; do
    if backend_alive; then
      return
    fi
    if ! is_running; then
      echo "启动失败，最近日志:" >&2
      tail -n 20 "${LOG_FILE}" >&2
      exit 1
    fi
    sleep 0.5
  done
  echo "进程已启动但 /health 未在 10 秒内就绪，最近日志:" >&2
  tail -n 20 "${LOG_FILE}" >&2
  exit 1
}

cmd_stop() {
  local pids=()
  if is_running; then
    pids+=("$(cat "${PID_FILE}" 2>/dev/null || true)")
  fi
  local extra
  extra="$(find_server_pids)"
  [[ -n "${extra}" ]] && pids+=(${extra})
  pids=($(printf '%s\n' "${pids[@]:-}" | sort -u | grep -v '^$' || true))
  if [[ ${#pids[@]} -eq 0 ]]; then
    echo "未在运行"
    rm -f "${PID_FILE}"
    return
  fi
  kill "${pids[@]}" 2>/dev/null || true
  for _ in {1..10}; do
    if ! find_server_pids | grep -q .; then
      break
    fi
    sleep 0.5
  done
  if find_server_pids | grep -q .; then
    echo "优雅停止超时，强制结束 (kill -9)"
    pkill -9 -f "${PROC_PATTERN}" 2>/dev/null || true
  fi
  rm -f "${PID_FILE}"
  echo "已停止 (PID: ${pids[*]})"
}

cmd_status() {
  if backend_alive; then
    local managed=""
    is_running && managed="（受管，PID $(cat "${PID_FILE}")）"
    echo "运行中${managed}"
  else
    echo "未运行"
    rm -f "${PID_FILE}"
  fi
}

cmd_logs() {
  if [[ ! -f "${LOG_FILE}" ]]; then
    echo "日志文件尚不存在: ${LOG_FILE}"
    exit 1
  fi
  tail -n 50 -f "${LOG_FILE}"
}

WATCH="${WATCH:-0}"
[[ "${2:-}" == "--watch" ]] && WATCH=1

case "${1:-}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  status)  cmd_status ;;
  logs)    cmd_logs ;;
  *)
    echo "用法: $0 {start|stop|restart|status|logs} [--watch]" >&2
    exit 1
    ;;
esac
