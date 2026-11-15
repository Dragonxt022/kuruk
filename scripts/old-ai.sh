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
  local agora carga total ok parados ready health sse=0 quic=0 inv=0 detalhes=""
  local kuma_down nd_warn veredito c l

  agora="$(date '+%Y-%m-%d %H:%M')"
  carga="$(cut -d' ' -f1-3 /proc/loadavg)"

  # ---- containers ----
  local lista
  lista="$(docker ps --format '{{.Names}}={{.Status}}' 2>/dev/null)"
  total="$(printf '%s\n' "$lista" | grep -c . || true)"
  ok="$(printf '%s\n' "$lista" | grep -c '=Up ' || true)"
  parados="$(printf '%s\n' "$lista" | grep -v '=Up ' | cut -d= -f1 | tr '\n' ' ' | sed 's/ $//')"

  # ---- tunel ----
  ready="$(docker exec old-home wget -q -T 5 -O- http://cloudflared:20241/ready 2>/dev/null \
           | sed -n 's/.*"readyConnections":\([0-9]*\).*/\1/p')"
  [ -z "$ready" ] && ready=0

  # ---- api publica ----
  health="$(curl -s -m 8 -o /dev/null -w '%{http_code}' https://kuruk.com.br/api/health 2>/dev/null)"
  [ -z "$health" ] && health=000

  # ---- erros classificados (ultima hora) ----
  for c in kuruk-cloud mysql uptime-kuma cloudflared; do
    while IFS= read -r l; do
      [ -z "$l" ] && continue
      case "$l" in
        *commands/events*|*"unexpected EOF"*|*"canceled by remote with error code 0"*|*originService=http://old-home:80*)
          sse=$((sse + 1)) ;;
        *"no recent network activity"*|*"Failed to dial a quic"*|*"accept stream listener"*|*"datagram manager"*)
          quic=$((quic + 1)) ;;
        *)
          inv=$((inv + 1))
          detalhes+="  [$c] $(printf '%s' "$l" | cut -c1-150)"$'\n' ;;
      esac
    done < <(docker logs --since 60m "$c" 2>&1 | grep -iE "error|fatal|failed" | tail -20)
  done

  # ---- monitores e alarmes ----
  kuma_down="$(docker exec -u node uptime-kuma sqlite3 /app/data/kuma.db "
    select count(*) from (
      select m.id, (select status from heartbeat where monitor_id = m.id order by time desc limit 1) s
      from monitor m where m.active = 1
    ) where s = 0;" 2>/dev/null | tr -dc '0-9')"
  [ -z "$kuma_down" ] && kuma_down=0

  nd_warn="$(curl -s -m 5 'http://127.0.0.1:19999/api/v1/alarms?all' 2>/dev/null \
    | grep -cE '"status": ?"(WARNING|CRITICAL)"' || true)"
  [ -z "$nd_warn" ] && nd_warn=0

  # ---- veredito calculado por regras (o modelo so precisa relatar) ----
  veredito=""
  [ "$ok" -lt "$total" ] && veredito+="containers parados: ${parados:-?}; "
  [ "$ready" -lt 2 ] && veredito+="tunel com apenas $ready conexao(oes); "
  [ "$health" != "200" ] && veredito+="api publica HTTP $health; "
  [ "$inv" -gt 0 ] && veredito+="$inv erro(s) sem classificacao conhecida; "
  [ "$kuma_down" -gt 0 ] && veredito+="$kuma_down monitor(es) DOWN no Kuma; "
  [ "$nd_warn" -gt 0 ] && veredito+="$nd_warn alarme(s) WARNING/CRITICAL no Netdata; "
  [ -z "$veredito" ] && veredito="nenhum problema real detectado"

  echo "DATA: $agora"
  echo "VEREDITO AUTOMATICO (calculado por regras): $veredito"
  echo "  containers: $ok/$total no ar"
  echo "  tunel cloudflared: $ready conexao(oes) ativas (ok a partir de 2)"
  echo "  api publica: HTTP $health"
  echo "  erros 60min: $sse benignos de SSE, $quic reconexoes QUIC, $inv para investigar"
  echo "  monitores Kuma DOWN: $kuma_down"
  echo "  alarmes Netdata WARNING/CRITICAL: $nd_warn"
  echo
  echo "CARGA: $carga em $(nproc) vCPU"
  echo "RAM: $(free -m | awk '/^Mem:/{print $3"MB usados de "$2"MB"}') | swap: $(free -m | awk '/^Swap:/{print $3"MB de "$2"MB"}')"
  echo "DISCO: $(df -h / | awk 'NR==2{print $3" usados de "$2" ("$5")"}')"
  echo
  echo "CONTAINERS:"
  printf '%s\n' "$lista" | sed 's/^/  /'
  echo
  echo "ALARMES NETDATA (diferentes de CLEAR):"
  curl -s -m 5 "http://127.0.0.1:19999/api/v1/alarms?all" | /usr/bin/python3 -c '
import json, sys
try:
    alarms = json.load(sys.stdin)["alarms"]
except Exception:
    sys.exit(0)
rows = [(v["status"], k, v.get("value_string") or "") for k, v in alarms.items() if v["status"] != "CLEAR"]
for status, key, value in rows[:8]:
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
  if [ "$inv" -gt 0 ]; then
    echo
    echo "ERROS PARA INVESTIGAR (60min):"
    printf '%s' "$detalhes"
  fi
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
Responda em portugues do Brasil, seco e objetivo, no maximo 12 linhas.

O bloco VEREDITO AUTOMATICO foi calculado por regras objetivas e tem prioridade
sobre a sua interpretacao. Se ele diz "nenhum problema real detectado", responda
que esta tudo ok e NAO invente risco.
Rodape de erro so aparece quando ha algo para investigar; ausencia disso = sem problema.
Nunca diga que um servico pode falhar se o tunel/health/monitores mostram ele no ar.
Formato:
1) DIAGNOSTICO: uma frase, alinhada ao veredito.
2) ATENCAO: riscos reais agora, ou "nada critico".
3) VERIFICAR: ate 3 comandos de leitura, um por linha (ou "nada a verificar").

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
