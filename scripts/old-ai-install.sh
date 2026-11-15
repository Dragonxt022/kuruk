#!/usr/bin/env bash
# old-ai-install.sh — instala/atualiza o kit old-ai no servidor.
#
# Copia os componentes para ~/bin, monta ~/etc/old-ai.env com o token do bot
# (lido do banco do Uptime Kuma), instala as entradas de cron e sobe o bot.
# Pode ser rodado de novo a qualquer momento (idempotente).
#
# Uso (com os arquivos na mesma pasta deste script):
#   bash old-ai-install.sh
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${HOME}/bin"
ETC_DIR="${HOME}/etc"
LOG_DIR="${HOME}/logs/old-ai"
STATE_DIR="${HOME}/.local/state/old-ai"
ENV_FILE="${ETC_DIR}/old-ai.env"

mkdir -p "$BIN_DIR" "$ETC_DIR" "$LOG_DIR" "$STATE_DIR"
chmod 700 "$ETC_DIR"

echo "[1/6] copiando componentes para $BIN_DIR"
install -m 755 "$SRC/old-ai.sh"      "$BIN_DIR/old-ai"
install -m 755 "$SRC/old-actions.sh" "$BIN_DIR/old-actions.sh"
install -m 755 "$SRC/old-watchdog.sh" "$BIN_DIR/old-watchdog.sh"
install -m 755 "$SRC/old-bot.py"     "$BIN_DIR/old-bot.py"

echo "[2/6] lendo token/chat do Uptime Kuma"
cfg="$(docker exec -u node uptime-kuma sqlite3 /app/data/kuma.db \
      "select config from notification where id = 1;")"
TOKEN="$(printf '%s' "$cfg" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["telegramBotToken"])')"
CHAT="$(printf '%s' "$cfg" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["telegramChatID"])')"
if [ -z "$TOKEN" ] || [ -z "$CHAT" ]; then
  echo "erro: nao consegui ler token/chat do Kuma" >&2
  exit 1
fi

echo "[3/6] gravando $ENV_FILE"
umask 077
cat > "$ENV_FILE" <<EOF
# Config do kit old-ai (gerado por old-ai-install.sh)
TELEGRAM_BOT_TOKEN=${TOKEN}
TELEGRAM_CHAT_ID=${CHAT}
ALLOWED_CHAT_ID=${CHAT}
OLD_AI_MODEL=qwen3:1.7b
OLLAMA_URL=http://127.0.0.1:11434
EOF
chmod 600 "$ENV_FILE"

echo "[4/6] instalando cron"
NOVO_CRON="$(cat <<EOF
# >>> old-ai
PATH=/usr/local/bin:/usr/bin:/bin
*/5 * * * * ${BIN_DIR}/old-watchdog.sh >> ${LOG_DIR}/watchdog.log 2>&1
* * * * * pgrep -f "[o]ld-bot.py" >/dev/null || setsid ${BIN_DIR}/old-bot.py >> ${LOG_DIR}/bot.log 2>&1 < /dev/null &
# <<< old-ai
EOF
)"
{ crontab -l 2>/dev/null | sed '/# >>> old-ai/,/# <<< old-ai/d' || true; printf '%s\n' "$NOVO_CRON"; } | crontab -
crontab -l | sed -n '/# >>> old-ai/,/# <<< old-ai/p'

echo "[5/6] subindo o bot"
if ! pgrep -f "[o]ld-bot.py" >/dev/null; then
  setsid "${BIN_DIR}/old-bot.py" >> "${LOG_DIR}/bot.log" 2>&1 < /dev/null &
  sleep 3
fi
pgrep -af "[o]ld-bot.py" || echo "aviso: bot nao apareceu no pgrep (veja $LOG_DIR/bot.log)"

echo "[6/6] teste do watchdog (silencioso = tudo ok)"
if "${BIN_DIR}/old-watchdog.sh"; then
  echo "watchdog: nenhum problema detectado"
else
  echo "watchdog: retornou erro (veja acima)"
fi

echo
echo "Instalacao concluida."
echo "  diagnostico:  ~/bin/old-ai \"sua pergunta\""
echo "  acoes:        ~/bin/old-actions.sh list"
echo "  logs:         $LOG_DIR/{bot,watchdog}.log"
echo "  telegram:     /status  /alerts  /ai <pergunta>  /fix"
