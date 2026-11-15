#!/usr/bin/env bash
# old-actions.sh — executa acoes de manutencao de uma ALLOWLIST fechada.
#
# Usado pelo bot do Telegram e pode ser chamado na mao. Qualquer acao fora da
# lista e recusada. Nao aceita argumentos livres: o nome da acao e' validado
# contra uma lista fixa, entao nao ha como injetar comando.
#
# Uso:
#   old-actions.sh list          # mostra as acoes permitidas
#   old-actions.sh restart-app   # reinicia o kuruk-cloud e valida o health
set -euo pipefail

APP_CONTAINER="${APP_CONTAINER:-kuruk-cloud}"
PUBLIC_HEALTH="${PUBLIC_HEALTH:-https://kuruk.com.br/api/health}"

acao="${1:-list}"

log() { printf '%s\n' "$*"; }

health_app() {
  docker exec "$APP_CONTAINER" wget -q -T 5 -O- http://127.0.0.1:3003/api/health 2>/dev/null || true
}

health_public() {
  curl -fsS -m 10 "$PUBLIC_HEALTH" 2>/dev/null || true
}

esperar_health_app() {
  local tentativa
  for tentativa in $(seq 1 10); do
    if health_app | grep -q '"ok":true'; then
      log "health interno: OK"
      return 0
    fi
    sleep 3
  done
  log "health interno: FALHOU apos 30s"
  return 1
}

case "$acao" in
  list)
    cat <<'EOF'
Acoes permitidas:
  restart-app      reinicia o container kuruk-cloud e valida /api/health
  restart-proxy    reinicia o nginx (old-home)
  restart-tunnel   reinicia o cloudflared e valida o site publico
  restart-kuma     reinicia o Uptime Kuma
  restart-ollama   reinicia o Ollama
  prune-images     remove imagens Docker sem uso com mais de 7 dias
  status           apenas le o estado (nao altera nada)
EOF
    ;;

  status)
    log "== containers =="
    docker ps --format '{{.Names}} | {{.Status}}'
    log "== health interno =="
    health_app
    log ""
    log "== health publico =="
    health_public
    log ""
    log "== disco =="
    df -h / | tail -1
    log "== memoria =="
    free -h | head -2
    ;;

  restart-app)
    log "reiniciando $APP_CONTAINER..."
    docker restart "$APP_CONTAINER" >/dev/null
    sleep 3
    esperar_health_app
    log "health publico: $(health_public || echo 'sem resposta')"
    ;;

  restart-proxy)
    log "reiniciando old-home..."
    docker restart old-home >/dev/null
    sleep 2
    docker ps --filter name=old-home --format 'old-home: {{.Status}}'
    log "health publico: $(health_public || echo 'sem resposta')"
    ;;

  restart-tunnel)
    log "reiniciando cloudflared..."
    docker restart cloudflared >/dev/null
    sleep 8
    docker ps --filter name=cloudflared --format 'cloudflared: {{.Status}}'
    log "health publico: $(health_public || echo 'sem resposta')"
    ;;

  restart-kuma)
    log "reiniciando uptime-kuma..."
    docker restart uptime-kuma >/dev/null
    sleep 10
    docker ps --filter name=uptime-kuma --format 'uptime-kuma: {{.Status}}'
    ;;

  restart-ollama)
    log "reiniciando ollama..."
    docker restart ollama >/dev/null
    for tentativa in $(seq 1 15); do
      if curl -sf -m 2 http://127.0.0.1:11434/api/version >/dev/null; then
        log "ollama: $(curl -s http://127.0.0.1:11434/api/version)"
        exit 0
      fi
      sleep 2
    done
    log "ollama: NAO subiu"
    exit 1
    ;;

  prune-images)
    log "removendo imagens sem uso com mais de 7 dias..."
    docker image prune -f --filter "until=168h"
    log ""
    df -h / | tail -1
    ;;

  *)
    log "acao recusada: '$acao' nao esta na allowlist"
    log "use: old-actions.sh list"
    exit 2
    ;;
esac
