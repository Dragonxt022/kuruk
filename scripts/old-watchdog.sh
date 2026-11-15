#!/usr/bin/env bash
# old-watchdog.sh — checagens que o Netdata e o Uptime Kuma NAO cobrem.
#
#  * daemon do Docker responde?
#  * algum container esperado caiu?
#  * algum container entrou em loop de restart?
#  * o backup diario do cloud rodou nas ultimas 26h?
#  * o certificado publico de kuruk.com.br vence em < 14 dias?
#  * a API do Ollama esta de pe?
#
# Quando algo falha, pede uma sugestao curta ao modelo local e manda no
# Telegram. Cada problema so alerta de novo depois de 30 min (anti-spam).
#
# Roda via cron a cada 5 minutos. Nao altera nada no servidor.
set -uo pipefail

BASE="${HOME}"
STATE_DIR="${BASE}/.local/state/old-ai"
ENV_FILE="${BASE}/etc/old-ai.env"
BACKUP_DIR="${BACKUP_DIR:-${BASE}/backups/kuruk-cloud}"
PUBLIC_HOST="${PUBLIC_HOST:-kuruk.com.br}"
MODEL="${OLD_AI_MODEL:-qwen3:1.7b}"
OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
EXPECTED="${EXPECTED_CONTAINERS:-kuruk-cloud old-home cloudflared mysql uptime-kuma netdata portainer ollama}"
DEDUPE_SECONDS=1800

mkdir -p "$STATE_DIR"

# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a

problemas=()
detalhes=()

add_problem() {
  problemas+=("$1")
  detalhes+=("$2")
}

# 1) Daemon do Docker
if ! docker info >/dev/null 2>&1; then
  add_problem "docker-daemon" "o daemon do Docker nao respondeu"
fi

# 2) Containers esperados
for nome in $EXPECTED; do
  estado="$(docker inspect -f '{{.State.Status}}' "$nome" 2>/dev/null || echo ausente)"
  if [ "$estado" != "running" ]; then
    add_problem "container-$nome" "container '$nome' esta '$estado'"
  fi
done

# 3) Loop de restart
for nome in $EXPECTED; do
  atual="$(docker inspect -f '{{.RestartCount}}' "$nome" 2>/dev/null || echo 0)"
  arquivo="$STATE_DIR/restarts-$nome"
  anterior="$(cat "$arquivo" 2>/dev/null || echo "$atual")"
  if [ "$atual" -gt "$anterior" ] 2>/dev/null; then
    add_problem "restart-$nome" "container '$nome' reiniciou sozinho ($anterior -> $atual restarts)"
  fi
  echo "$atual" > "$arquivo"
done

# 4) Backup diario (diretorios AAAA-MM-DD_HHMM)
if [ -d "$BACKUP_DIR" ]; then
  mais_novo="$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20*' -printf '%T@\n' 2>/dev/null | sort -n | tail -1)"
  if [ -z "$mais_novo" ]; then
    add_problem "backup-ausente" "nenhum backup encontrado em $BACKUP_DIR"
  else
    agora="$(date +%s)"
    idade=$(( agora - ${mais_novo%.*} ))
    if [ "$idade" -gt 93600 ]; then
      add_problem "backup-velho" "ultimo backup tem $(( idade / 3600 ))h (limite 26h) em $BACKUP_DIR"
    fi
  fi
fi

# 5) Certificado publico
fim="$(echo | timeout 15 openssl s_client -servername "$PUBLIC_HOST" -connect "$PUBLIC_HOST:443" 2>/dev/null \
      | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
if [ -n "$fim" ]; then
  dias="$(/usr/bin/python3 -c '
import sys
from datetime import datetime, timezone
try:
    fim = datetime.strptime(sys.argv[1].strip(), "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
    print((fim - datetime.now(timezone.utc)).days)
except Exception:
    print("")
' "$fim")"
  if [ -n "$dias" ] && [ "$dias" -lt 14 ]; then
    add_problem "tls-$PUBLIC_HOST" "certificado de $PUBLIC_HOST vence em $dias dias"
  fi
else
  add_problem "tls-$PUBLIC_HOST" "nao consegui ler o certificado de $PUBLIC_HOST"
fi

# 6) Ollama
if ! curl -sf -m 5 "$OLLAMA_URL/api/version" >/dev/null; then
  add_problem "ollama" "a API do Ollama nao respondeu em $OLLAMA_URL"
fi

[ "${#problemas[@]}" -eq 0 ] && exit 0

# Anti-spam: cada chave so alerta 1x a cada 30 min.
novos=()
novos_detalhes=()
for i in "${!problemas[@]}"; do
  chave="${problemas[$i]}"
  marca="$STATE_DIR/alerta-$chave"
  if [ -f "$marca" ] && [ $(( $(date +%s) - $(stat -c %Y "$marca") )) -lt "$DEDUPE_SECONDS" ]; then
    continue
  fi
  : > "$marca"
  novos+=("$chave")
  novos_detalhes+=("${detalhes[$i]}")
done

[ "${#novos[@]}" -eq 0 ] && exit 0

texto_problemas="$(printf '%s\n' "${novos_detalhes[@]}")"

# Sugestao da IA (curta, com timeout).
ctx="PROBLEMAS NO SERVIDOR OLD:
${texto_problemas}

ESTADO:
$(docker ps --format '{{.Names}}={{.Status}}' 2>/dev/null | head -20)
RAM: $(free -m | awk '/^Mem:/{print $7"MB livres"}')
DISCO: $(df -h / | awk 'NR==2{print $5}')"

req="$(mktemp)"
resp="$(mktemp)"
CTX="$ctx" MODEL="$MODEL" /usr/bin/python3 -c '
import json, os
prompt = f"""Voce e o Old, sysadmin do servidor Linux (2 vCPU, 7 GB RAM, Docker).
Os problemas abaixo foram detectados automaticamente.
Responda em portugues, no maximo 5 linhas, sem inventar dados:
1) causa provavel de cada problema;
2) ate 3 comandos de diagnostico (somente leitura).

## PROBLEMAS E ESTADO
{os.environ["CTX"]}
"""
print(json.dumps({"model": os.environ["MODEL"], "prompt": prompt, "stream": False,
                  "think": False, "keep_alive": "10m",
                  "options": {"temperature": 0.2, "num_predict": 180, "num_ctx": 4096}},
                 ensure_ascii=False))
' > "$req"

sugestao="$(curl -sS -m 150 -X POST "$OLLAMA_URL/api/generate" -H 'Content-Type: application/json' \
  --data-binary "@$req" 2>/dev/null | /usr/bin/python3 -c '
import json, sys
try:
    print((json.load(sys.stdin).get("response") or "").strip())
except Exception:
    print("")
' 2>/dev/null)"
rm -f "$req" "$resp"

msg="🚨 OLD - watchdog

${texto_problemas}

Sugestao do Old:
${sugestao:-(sem sugestao da IA agora)}"

if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
  curl -sS -m 20 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${msg}" >/dev/null 2>&1 || echo "watchdog: falha ao enviar Telegram"
  echo "[$(date '+%F %T')] alertado: ${problemas[*]}"
else
  echo "[$(date '+%F %T')] problemas sem Telegram configurado: ${detalhes[*]}"
fi
