#!/usr/bin/env python3
"""old-bot.py — bot de plantao do servidor OLD no Telegram.

Comandos:
  /status           estado rapido (containers, health, disco, RAM)
  /alerts           alarmes do Netdata e ultimo resultado dos monitores
  /ai <pergunta>    diagnostico com o modelo local (somente leitura)
  /fix              lista as acoes permitidas
  /fix <acao>       pede confirmacao (gera um codigo de 5 min)
  /confirm <codigo> executa a acao confirmada
  /cancel           descarta a acao pendente
  /help

Seguranca:
  * so responde ao chat configurado em ALLOWED_CHAT_ID;
  * acoes vem de uma allowlist fixa (scripts/old-actions.sh);
  * acao so executa depois de /confirm com codigo de uso unico e 5 min;
  * nada de execucao de texto livre.

Roda por long polling (sem webhook). Deve existir uma unica instancia: o
proprio script segura um flock e sai se ja houver outra.
"""
import fcntl
import json
import os
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HOME = Path.home()
ENV_FILE = HOME / "etc" / "old-ai.env"
BIN = HOME / "bin"
STATE_DIR = HOME / ".local" / "state" / "old-ai"
PENDING_FILE = STATE_DIR / "pending.json"
LOCK_FILE = STATE_DIR / "bot.lock"
ACTIONS_BIN = BIN / "old-actions.sh"
AI_BIN = BIN / "old-ai"

ALLOWED_ACTIONS = {
    "restart-app",
    "restart-proxy",
    "restart-tunnel",
    "restart-kuma",
    "restart-ollama",
    "prune-images",
    "status",
}

MAX_TELEGRAM = 3900


def log(msg: str) -> None:
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def load_env() -> None:
    if not ENV_FILE.exists():
        log(f"erro: {ENV_FILE} nao existe")
        sys.exit(1)
    for linha in ENV_FILE.read_text(encoding="utf-8").splitlines():
        linha = linha.strip()
        if not linha or linha.startswith("#"):
            continue
        if linha.startswith("export "):
            linha = linha[len("export "):]
        if "=" not in linha:
            continue
        chave, valor = linha.split("=", 1)
        valor = valor.strip().strip('"').strip("'")
        os.environ.setdefault(chave.strip(), valor)


def tg(method: str, **params):
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    dados = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/{method}", data=dados
    )
    with urllib.request.urlopen(req, timeout=70) as resp:
        return json.loads(resp.read().decode())


def enviar(chat_id: int, texto: str) -> None:
    texto = texto.strip() or "(vazio)"
    for inicio in range(0, len(texto), MAX_TELEGRAM):
        tg("sendMessage", chat_id=chat_id, text=texto[inicio:inicio + MAX_TELEGRAM])


def digitando(chat_id: int) -> None:
    try:
        tg("sendChatAction", chat_id=chat_id, action="typing")
    except Exception:
        pass


def rodar(cmd: list[str], timeout: int = 120) -> str:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        saida = (p.stdout or "") + (p.stderr or "")
        return saida.strip() or "(sem saida)"
    except subprocess.TimeoutExpired:
        return f"(tempo esgotado apos {timeout}s)"
    except Exception as exc:  # noqa: BLE001
        return f"(erro ao executar: {exc})"


def resumo_status() -> str:
    containers = rodar(["docker", "ps", "--format", "{{.Names}} | {{.Status}}"], 30)
    health = rodar(
        ["bash", "-lc",
         "curl -fsS -m 10 https://kuruk.com.br/api/health 2>/dev/null || echo 'SEM RESPOSTA'"],
        30,
    )
    disco = rodar(["bash", "-lc", "df -h / | tail -1"], 15)
    memoria = rodar(["bash", "-lc", "free -h | sed -n '2p'"], 15)
    carga = rodar(["bash", "-lc", "cut -d' ' -f1-3 /proc/loadavg"], 15)
    return (
        f"Containers:\n{containers}\n\n"
        f"Health publico: {health}\n"
        f"Disco: {disco}\n"
        f"RAM: {memoria}\n"
        f"Carga: {carga}"
    )


def resumo_alertas() -> str:
    netdata = rodar(
        ["bash", "-lc",
         "curl -s -m 8 http://127.0.0.1:19999/api/v1/alarms?all | "
         "/usr/bin/python3 -c 'import json,sys; a=json.load(sys.stdin)[\"alarms\"]; "
         "rows=[(v[\"status\"],k) for k,v in a.items() if v[\"status\"] in (\"WARNING\",\"CRITICAL\")]; "
         "print(\"\\n\".join(s+\" \"+k for s,k in rows[:10]) or \"nenhum alarme ativo\")'"],
        40,
    )
    kuma = rodar(
        ["bash", "-lc",
         "docker exec -u node uptime-kuma sqlite3 -separator ' = ' /app/data/kuma.db "
         "\"select m.name, case h.status when 1 then 'UP' when 0 then 'DOWN' when 2 then 'PENDING' "
         "else h.status end from heartbeat h join monitor m on m.id=h.monitor_id "
         "where h.time=(select max(time) from heartbeat where monitor_id=h.monitor_id) order by m.id;\""],
        40,
    )
    return f"Netdata:\n{netdata}\n\nUptime Kuma:\n{kuma}"


def acao_pendente() -> dict | None:
    if not PENDING_FILE.exists():
        return None
    try:
        return json.loads(PENDING_FILE.read_text(encoding="utf-8"))
    except Exception:
        return None


def limpar_pendente() -> None:
    PENDING_FILE.unlink(missing_ok=True)


def pedir_confirmacao(chat_id: int, acao: str) -> None:
    if acao not in ALLOWED_ACTIONS:
        enviar(chat_id, f"Acao '{acao}' nao esta na allowlist. Use /fix para ver as opcoes.")
        return
    if acao == "status":
        enviar(chat_id, resumo_status())
        return
    codigo = secrets.token_hex(3)
    PENDING_FILE.write_text(
        json.dumps({"acao": acao, "codigo": codigo, "expira": time.time() + 300}),
        encoding="utf-8",
    )
    enviar(
        chat_id,
        f"Confirmar a acao: {acao}\n\n"
        f"Responda em ate 5 minutos:\n/confirm {codigo}\n\n"
        f"Para descartar: /cancel",
    )


def executar_confirmacao(chat_id: int, texto: str) -> None:
    pendente = acao_pendente()
    if not pendente:
        enviar(chat_id, "Nenhuma acao pendente. Use /fix <acao>.")
        return
    partes = texto.split()
    codigo = partes[1].strip() if len(partes) > 1 else ""
    if codigo != pendente.get("codigo"):
        enviar(chat_id, "Codigo invalido. Use /cancel para descartar ou /fix <acao> de novo.")
        return
    if time.time() > pendente.get("expira", 0):
        limpar_pendente()
        enviar(chat_id, "Codigo expirado (5 min). Peca de novo com /fix <acao>.")
        return

    acao = pendente["acao"]
    limpar_pendente()
    digitando(chat_id)
    enviar(chat_id, f"Executando {acao}...")
    saida = rodar([str(ACTIONS_BIN), acao], timeout=240)
    enviar(chat_id, f"[{acao}]\n{saida}")


def ajuda() -> str:
    return (
        "Comandos do Old:\n"
        "/status - containers, health, disco, RAM\n"
        "/alerts - Netdata + Uptime Kuma\n"
        "/ai <pergunta> - diagnostico com a IA local\n"
        "/fix - lista acoes permitidas\n"
        "/fix <acao> - pede confirmacao\n"
        "/confirm <codigo> - executa a acao\n"
        "/cancel - descarta a acao pendente\n\n"
        "A IA nunca executa nada sozinha: acoes passam por allowlist + confirmacao."
    )


def tratar(chat_id: int, texto: str) -> None:
    texto = texto.strip()
    if not texto:
        return
    if not texto.startswith("/"):
        texto = "/ai " + texto

    comando, _, resto = texto.partition(" ")
    comando = comando.split("@")[0].lower()
    resto = resto.strip()

    if comando in ("/start", "/help"):
        enviar(chat_id, ajuda())
    elif comando == "/status":
        enviar(chat_id, resumo_status())
    elif comando == "/alerts":
        enviar(chat_id, resumo_alertas())
    elif comando == "/ai":
        if not resto:
            enviar(chat_id, "Uso: /ai por que o site esta lento?")
            return
        digitando(chat_id)
        enviar(chat_id, "Consultando o modelo local... (pode levar ~1 min)")
        saida = rodar([str(AI_BIN), resto], timeout=600)
        enviar(chat_id, saida)
    elif comando == "/fix":
        if not resto:
            enviar(chat_id, rodar([str(ACTIONS_BIN), "list"], 30))
        else:
            pedir_confirmacao(chat_id, resto.lower())
    elif comando == "/confirm":
        executar_confirmacao(chat_id, texto)
    elif comando == "/cancel":
        limpar_pendente()
        enviar(chat_id, "Acao pendente descartada.")
    else:
        enviar(chat_id, "Comando nao reconhecido.\n\n" + ajuda())


def main() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    load_env()

    if not os.environ.get("TELEGRAM_BOT_TOKEN") or not os.environ.get("ALLOWED_CHAT_ID"):
        log("erro: TELEGRAM_BOT_TOKEN/ALLOWED_CHAT_ID ausentes no env")
        sys.exit(1)
    if not os.access(ACTIONS_BIN, os.X_OK):
        log(f"aviso: {ACTIONS_BIN} nao e executavel")

    trava = open(LOCK_FILE, "w")  # noqa: SIM115
    try:
        fcntl.flock(trava, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        log("outra instancia do bot ja esta rodando; saindo")
        return

    permitido = str(os.environ["ALLOWED_CHAT_ID"]).strip()
    log(f"bot iniciado (chat autorizado: {permitido})")

    # Pula o backlog: sem isso, um restart do bot reexecutaria comandos antigos
    # (inclusive um /confirm pendente) que ainda estao no buffer do Telegram.
    offset = 0
    try:
        ultimo = tg("getUpdates", offset=-1, timeout=0)
        for upd in ultimo.get("result", []):
            offset = max(offset, upd["update_id"] + 1)
    except Exception as exc:  # noqa: BLE001
        log(f"aviso: nao consegui pular o backlog: {exc}")

    while True:
        try:
            dados = tg(
                "getUpdates",
                offset=offset,
                timeout=50,
                allowed_updates=json.dumps(["message"]),
            )
            for upd in dados.get("result", []):
                offset = max(offset, upd["update_id"] + 1)
                msg = upd.get("message") or {}
                chat = msg.get("chat", {})
                chat_id = chat.get("id")
                texto = msg.get("text") or ""
                if str(chat_id) != permitido:
                    log(f"mensagem ignorada de chat nao autorizado: {chat_id}")
                    continue
                log(f"<- {texto[:80]!r}")
                tratar(chat_id, texto)
        except urllib.error.HTTPError as exc:
            corpo = exc.read().decode(errors="replace")[:200]
            log(f"HTTP {exc.code}: {corpo}")
            time.sleep(5 if exc.code == 409 else 10)
        except Exception as exc:  # noqa: BLE001
            log(f"erro no loop: {exc}")
            time.sleep(5)


if __name__ == "__main__":
    main()
