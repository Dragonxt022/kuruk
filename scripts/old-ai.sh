#!/usr/bin/env bash
# old-ai — diagnostico assistido do servidor OLD usando Ollama (qwen3:0.6b).
#
# Coleta um resumo compacto do estado (containers, memoria, disco, alarmes do
# Netdata, monitores do Uptime Kuma e erros recentes), manda para o modelo local
# e imprime um diagnostico com comandos sugeridos.
#
# IMPORTANTE: este script NAO executa nada do que a IA sugere. Ele so le e imprime.
#
# Uso:
#   old-ai                      # diagnostico geral
#   old-ai "por que o site esta lento?"
#   OLD_AI_MODEL=qwen3:1.7b old-ai
set -euo pipefail

# Config compartilhada (token do Telegram, modelo, URL do Ollama).
if [ -f "${HOME}/etc/old-ai.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "${HOME}/etc/old-ai.env"
  set +a
fi

MODEL="${OLD_AI_MODEL:-qwen3:1.7b}"
OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
LOCK_FILE="${TMPDIR:-/tmp}/old-ai.lock"
MAX_CTX_CHARS="${OLD_AI_MAX_CTX:-6000}"

PERGUNTA="${*:-Faca um diagnostico geral do servidor e diga o que merece atencao agora.}"

collect_context() {
  echo "DATA: $(date '+%Y-%m-%d %H:%M')"
  echo "CARGA:$(cut -d' ' -f1-3 /proc/loadavg) em $(nproc) vCPU"
  echo "RAM: $(free -m | awk '/^Mem:/{print $3"MB usados de "$2"MB"}') | swap: $(free -m | awk '/^Swap:/{print $3"MB de "$2"MB"}')"
  echo "DISCO: $(df -h / | awk 'NR==2{print $3" usados de "$2" ("$5")"}')"
  echo
  echo "CONTAINERS:"
  docker ps --format '{{.Names}}={{.Status}}' 2>/dev/null | sed 's/^/  /' || true
  echo "CONSUMO:"
  docker stats --no-stream --format '  {{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}' 2>/dev/null || true
  echo
  echo "ALARMES NETDATA (diferentes de CLEAR):"
  curl -s -m 5 "http://127.0.0.1:19999/api/v1/alarms?all" | /usr/bin/python3 -c '
import json, sys
try:
    alarms = json.load(sys.stdin)["alarms"]
except Exception:
    sys.exit(0)
rows = [(v["status"], k, v.get("value_string") or "") for k, v in alarms.items() if v["status"] != "CLEAR"]
for status, key, value in rows[:12]:
    print("  ", status, key, value)
if not rows:
    print("   nenhum")
' 2>/dev/null || true
  echo
  echo "MONITORES UPTIME KUMA:"
  docker exec -u node uptime-kuma sqlite3 -separator '=' /app/data/kuma.db "
    select m.name, case h.status when 1 then 'UP' when 0 then 'DOWN' when 2 then 'PENDING' else h.status end
    from heartbeat h join monitor m on m.id = h.monitor_id
    where h.time = (select max(time) from heartbeat where monitor_id = h.monitor_id);
  " 2>/dev/null | sed 's/^/  /' || true
  echo
  echo "ERROS RECENTES (ultima hora):"
  for c in kuruk-cloud mysql uptime-kuma cloudflared; do
    msg=$(docker logs --since 60m "$c" 2>&1 | grep -iE "error|fatal|failed" | tail -2 | tr '\n' ' ' | cut -c1-180)
    [ -n "$msg" ] && echo "  [$c] $msg"
  done
  echo "  (fim)"
}

# Serializa as execucoes: o modelo e' pequeno e roda na CPU, sem paralelismo.
exec 9>"$LOCK_FILE"
if ! flock -w 300 9; then
  echo "old-ai: outra execucao esta em andamento (esperei 5 min). Tente de novo." >&2
  exit 1
fi

if ! curl -sf -m 5 "$OLLAMA_URL/api/version" >/dev/null; then
  echo "old-ai: Ollama nao responde em $OLLAMA_URL" >&2
  exit 1
fi

CTX="$(collect_context 2>/dev/null | head -c "$MAX_CTX_CHARS")"

REQ_FILE="$(mktemp)"
RESP_FILE="$(mktemp)"
trap 'rm -f "$REQ_FILE" "$RESP_FILE"' EXIT

CONTEXT="$CTX" PERGUNTA="$PERGUNTA" MODEL="$MODEL" /usr/bin/python3 -c '
import json, os
prompt = f"""Voce e o Old, sysadmin do servidor Linux "old" (2 vCPU, 7 GB RAM, Docker).
Responda em portugues do Brasil, seco e objetivo, no maximo 15 linhas.

Use SOMENTE os dados do ESTADO abaixo.
Formato:
1) DIAGNOSTICO: uma frase.
2) ATENCAO: riscos reais agora, ou "nada critico".
3) VERIFICAR: ate 4 comandos de leitura (docker ps, docker logs, df, free...), um por linha.

## ESTADO
{os.environ["CONTEXT"]}

## PERGUNTA
{os.environ["PERGUNTA"]}
"""
print(json.dumps({
    "model": os.environ["MODEL"],
    "prompt": prompt,
    "stream": False,
    "think": False,
    "keep_alive": "10m",
    "options": {"temperature": 0.2, "num_predict": 260, "num_ctx": 4096},
}, ensure_ascii=False))
' > "$REQ_FILE"

curl -sS -m 600 -X POST "$OLLAMA_URL/api/generate" \
  -H 'Content-Type: application/json' \
  --data-binary "@$REQ_FILE" > "$RESP_FILE"

/usr/bin/python3 - "$RESP_FILE" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print("old-ai: resposta invalida do Ollama:", open(sys.argv[1]).read()[:300])
    sys.exit(1)
print((d.get("response") or "").strip())
dur = (d.get("total_duration") or 0) / 1e9
cnt = d.get("eval_count") or 0
pcnt = d.get("prompt_eval_count") or 0
if dur:
    print(f"\n[{pcnt} tokens de contexto + {cnt} gerados em {dur:.0f}s]")
PY
