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
import html
import json
import os
import re
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

MAX_TELEGRAM = 3800
ORDEM_CONTAINERS = [
    "kuruk-cloud", "old-home", "cloudflared", "mysql",
    "uptime-kuma", "netdata", "ollama", "portainer",
]


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


def esc(valor) -> str:
    return html.escape(str(valor), quote=False)


def tg(method: str, **params):
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    dados = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/{method}", data=dados
    )
    with urllib.request.urlopen(req, timeout=70) as resp:
        return json.loads(resp.read().decode())


def enviar(chat_id: int, texto: str) -> None:
    """Envia em HTML; se o Telegram reclamar, reenvia como texto puro."""
    texto = texto.strip() or "(vazio)"
    for inicio in range(0, len(texto), MAX_TELEGRAM):
        parte = texto[inicio:inicio + MAX_TELEGRAM]
        if inicio > 0:
            # Pedaco no meio de uma tag quebraria o parse: manda cru.
            parte = html.unescape(re.sub(r"<[^>]+>", "", parte))
        try:
            tg("sendMessage", chat_id=chat_id, text=parte, parse_mode="HTML",
               disable_web_page_preview=True)
        except urllib.error.HTTPError as exc:
            if exc.code != 400:
                raise
            sem_tags = html.unescape(re.sub(r"<[^>]+>", "", parte))
            tg("sendMessage", chat_id=chat_id, text=sem_tags,
               disable_web_page_preview=True)


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


def _uptime_curto(status: str) -> tuple[str, str]:
    """Devolve (emoji, tempo curto) a partir do Status do docker ps."""
    s = status.strip()
    emoji = "🟢"
    if "unhealthy" in s:
        emoji = "🟠"
    if s.startswith(("Exited", "Dead", "Created")) or "Restarting" in s:
        return "🔴", "parado"
    m = re.match(r"Up\s+(.+?)(?:\s*\(.*\))?$", s)
    if not m:
        return emoji, s[:20]
    t = m.group(1).strip()
    trocas = [
        ("Less than a second", "<1s"), ("About a minute", "1m"),
        ("About an hour", "1h"), ("About a day", "1d"),
        (" seconds", "s"), (" second", "s"),
        (" minutes", "m"), (" minute", "m"),
        (" hours", "h"), (" hour", "h"),
        (" days", "d"), (" day", "d"),
        (" weeks", "sem"), (" week", "sem"),
        (" months", "mes"), (" month", "mes"),
        (" years", "a"), (" year", "a"),
    ]
    for de, para in trocas:
        t = t.replace(de, para)
    return emoji, t.replace(", ", " ")


def _num_br(valor: str) -> str:
    return valor.replace(".", ",", 1) if "." in valor else valor


def bloco_containers() -> str:
    saida = rodar(["docker", "ps", "--format", "{{.Names}}\t{{.Status}}"], 30)
    if saida.startswith("("):
        return f"🔴 <b>Containers</b> · {esc(saida)}"
    linha_containers = []
    for linha in saida.splitlines():
        if "\t" not in linha:
            continue
        nome, status = linha.split("\t", 1)
        emoji, tempo = _uptime_curto(status)
        linha_containers.append((nome.strip(), emoji, tempo))
    if not linha_containers:
        return "📦 <b>Containers</b> · nenhum no ar"

    ordem = {nome: i for i, nome in enumerate(ORDEM_CONTAINERS)}
    linha_containers.sort(key=lambda item: (ordem.get(item[0], 99), item[0]))
    no_ar = sum(1 for _, emoji, _ in linha_containers if emoji == "🟢")
    corpo = "\n".join(
        f"{emoji} {esc(nome)} · {esc(tempo)}" for nome, emoji, tempo in linha_containers
    )
    return (
        f"📦 <b>Containers</b> · {no_ar}/{len(linha_containers)} no ar\n{corpo}"
    )


def bloco_health() -> str:
    saida = rodar(
        ["bash", "-lc",
         "curl -s -m 10 -w '|%{http_code}|%{time_total}' https://kuruk.com.br/api/health"],
        20,
    )
    corpo, codigo, tempo = (saida.rsplit("|", 2) + ["", "", ""])[:3]
    ok = '"ok":true' in corpo.replace(" ", "")
    icone = "✅" if ok else "🔴"
    detalhe = (
        f"{codigo} · {_num_br(f'{float(tempo):.2f}')}s"
        if codigo.isdigit() and tempo else "sem resposta"
    )
    return f"🌐 <b>API pública</b> · {icone} {esc(detalhe)}"


def bloco_recursos() -> str:
    disco = rodar(["bash", "-lc", "df -h -P / | tail -1"], 15).split()
    disco_txt = "?"
    if len(disco) >= 6:
        usado, total, pct = disco[2], disco[1], disco[4]
        disco_txt = f"{usado} de {total} · {pct}"

    ram = rodar(["bash", "-lc", "free -m | sed -n '2p'"], 15).split()
    ram_txt = "?"
    if len(ram) >= 7:
        total, usado, livre = ram[1], ram[2], ram[6]
        ram_txt = (
            f"{_num_br(f'{int(usado)/1024:.1f}G')} de "
            f"{_num_br(f'{int(total)/1024:.1f}G')} · livre "
            f"{_num_br(f'{int(livre)/1024:.1f}G')}"
        )

    carga = rodar(["bash", "-lc", "cut -d' ' -f1-3 /proc/loadavg"], 15)
    carga_txt = " · ".join(carga.split()) if not carga.startswith("(") else "?"

    return (
        f"💾 <b>Disco</b> · {esc(disco_txt)}\n"
        f"🧠 <b>RAM</b> · {esc(ram_txt)}\n"
        f"⚖️ <b>Carga</b> · {esc(carga_txt)}"
    )


def bloco_tunel() -> str:
    saida = rodar(
        ["bash", "-lc",
         "docker exec old-home wget -q -T 5 -O- http://cloudflared:20241/ready 2>/dev/null"],
        20,
    )
    m = re.search(r'"readyConnections":\s*(\d+)', saida)
    if not m:
        return "🚇 <b>Túnel</b> · 🔴 sem resposta"
    conexoes = int(m.group(1))
    icone = "🟢" if conexoes >= 2 else ("🟠" if conexoes == 1 else "🔴")
    return f"🚇 <b>Túnel</b> · {icone} {conexoes} conexões ativas"


def resumo_status() -> str:
    agora = time.strftime("%d/%m %H:%M")
    return (
        f"🖥️ <b>OLD</b> · {agora}\n\n"
        f"{bloco_containers()}\n\n"
        f"{bloco_health()}\n"
        f"{bloco_tunel()}\n"
        f"{bloco_recursos()}"
    )


def bloco_netdata() -> str:
    saida = rodar(
        ["bash", "-lc",
         "curl -s -m 8 http://127.0.0.1:19999/api/v1/alarms?all | "
         "/usr/bin/python3 -c 'import json,sys; a=json.load(sys.stdin)[\"alarms\"]; "
         "rows=[(v[\"status\"],k,v.get(\"value_string\") or \"\") for k,v in a.items() "
         "if v[\"status\"] in (\"WARNING\",\"CRITICAL\")]; "
         "print(\"\\n\".join(s+\"|\"+k+\"|\"+val for s,k,val in rows[:8]) or \"nenhum\")'"],
        40,
    )
    if saida.strip() == "nenhum":
        return "🧠 <b>Netdata</b> · nenhum alerta ativo ✅"
    if saida.startswith("("):
        return f"🧠 <b>Netdata</b> · {esc(saida)}"
    linhas = []
    for linha in saida.splitlines():
        partes = linha.split("|")
        if len(partes) < 2:
            continue
        status, chave = partes[0], partes[1]
        valor = partes[2] if len(partes) > 2 else ""
        icone = "🔴" if status == "CRITICAL" else "🟠"
        nome = chave.split(".")[-1]
        linhas.append(f"{icone} {esc(nome)} · {esc(valor or status)}")
    return "🧠 <b>Netdata</b>\n" + "\n".join(linhas)


def bloco_kuma() -> str:
    saida = rodar(
        ["bash", "-lc",
         "docker exec -u node uptime-kuma sqlite3 -separator '|' /app/data/kuma.db "
         "\"select m.name, h.status, ifnull(h.msg,'') from heartbeat h join monitor m "
         "on m.id=h.monitor_id where h.time=(select max(time) from heartbeat "
         "where monitor_id=h.monitor_id) order by m.id;\""],
        40,
    )
    if saida.startswith("("):
        return f"📡 <b>Uptime Kuma</b> · {esc(saida)}"
    linhas = []
    for linha in saida.splitlines():
        partes = linha.split("|")
        if len(partes) < 2:
            continue
        nome, status = partes[0], partes[1]
        msg = partes[2] if len(partes) > 2 else ""
        icone = {"1": "🟢", "0": "🔴", "2": "🟠"}.get(status, "⚪")
        rotulo = {"1": "UP", "0": "DOWN", "2": "PENDING"}.get(status, status)
        detalhe = f" · {esc(msg[:28])}" if msg and status != "1" else ""
        linhas.append(f"{icone} {esc(nome)} · {rotulo}{detalhe}")
    if not linhas:
        return "📡 <b>Uptime Kuma</b> · sem dados"
    return "📡 <b>Uptime Kuma</b>\n" + "\n".join(linhas)


def resumo_alertas() -> str:
    agora = time.strftime("%d/%m %H:%M")
    return (
        f"🔔 <b>Alertas</b> · {agora}\n\n"
        f"{bloco_netdata()}\n\n"
        f"{bloco_kuma()}"
    )


def acoes_disponiveis() -> list[tuple[str, str]]:
    saida = rodar([str(ACTIONS_BIN), "list"], 30)
    acoes = []
    for linha in saida.splitlines():
        m = re.match(r"^\s{2}(\S+)\s{2,}(.+)$", linha)
        if m:
            acoes.append((m.group(1), m.group(2).strip()))
    return acoes


def texto_acoes() -> str:
    acoes = acoes_disponiveis()
    if not acoes:
        return "Nao consegui ler a allowlist."
    corpo = "\n".join(f"• <b>{esc(nome)}</b> — {esc(desc)}" for nome, desc in acoes)
    return (
        "🛠️ <b>Ações permitidas</b>\n\n"
        f"{corpo}\n\n"
        "Para executar: <code>/fix &lt;acao&gt;</code>"
    )


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
    permitidas = dict(acoes_disponiveis())
    if acao not in ALLOWED_ACTIONS or acao not in permitidas:
        enviar(chat_id, "Essa ação não está na allowlist.\n\n" + texto_acoes())
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
        "⚠️ <b>Confirmar ação</b>\n\n"
        f"🧨 <b>{esc(acao)}</b>\n"
        f"{esc(permitidas[acao])}\n\n"
        f"Se tiver certeza: <code>/confirm {codigo}</code>\n"
        "⏱ expira em 5 minutos · /cancel para descartar",
    )


def executar_confirmacao(chat_id: int, texto: str) -> None:
    pendente = acao_pendente()
    if not pendente:
        enviar(chat_id, "Nenhuma ação pendente. Use /fix para ver as opções.")
        return
    partes = texto.split()
    codigo = partes[1].strip() if len(partes) > 1 else ""
    if codigo != pendente.get("codigo"):
        enviar(chat_id, "Código inválido. Use /cancel para descartar ou /fix <acao> de novo.")
        return
    if time.time() > pendente.get("expira", 0):
        limpar_pendente()
        enviar(chat_id, "Código expirado (5 min). Peça de novo com /fix <acao>.")
        return

    acao = pendente["acao"]
    limpar_pendente()
    digitando(chat_id)
    enviar(chat_id, f"⏳ Executando <b>{esc(acao)}</b>...")
    saida = rodar([str(ACTIONS_BIN), acao], timeout=240)
    enviar(chat_id, f"✅ <b>{esc(acao)}</b>\n<pre>{esc(saida)}</pre>")


def enviar_ai(chat_id: int, saida: str) -> None:
    linhas = saida.strip().splitlines()
    rodape = ""
    if linhas and linhas[-1].startswith("[") and linhas[-1].endswith("]"):
        rodape = linhas.pop()
    corpo = "\n".join(linhas).strip() or "(sem resposta)"
    partes = [corpo[i:i + 3300] for i in range(0, len(corpo), 3300)]
    for indice, parte in enumerate(partes):
        cabecalho = "🤖 <b>Old</b>\n\n" if indice == 0 else ""
        enviar(chat_id, f"{cabecalho}<pre>{esc(parte)}</pre>")
    if rodape:
        enviar(chat_id, f"<i>{esc(rodape)}</i>")


def ajuda() -> str:
    return (
        "🤖 <b>Old · sentinela do servidor</b>\n\n"
        "<b>Consultar</b>\n"
        "/status · containers, API, disco e RAM\n"
        "/alerts · Netdata + Uptime Kuma\n"
        "/ai <i>&lt;pergunta&gt;</i> · diagnóstico com a IA local\n\n"
        "<b>Agir</b>\n"
        "/fix · ações permitidas\n"
        "/confirm <i>&lt;código&gt;</i> · executa a ação confirmada\n"
        "/cancel · descarta a pendência\n\n"
        "<i>Nada é executado sem a sua confirmação.</i>"
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
            enviar(chat_id, "Uso: <code>/ai por que o site esta lento?</code>")
            return
        digitando(chat_id)
        enviar(chat_id, "🤖 Consultando o modelo local... (pode levar ~1 min)")
        enviar_ai(chat_id, rodar([str(AI_BIN), resto], timeout=600))
    elif comando == "/fix":
        if not resto:
            enviar(chat_id, texto_acoes())
        else:
            pedir_confirmacao(chat_id, resto.lower())
    elif comando == "/confirm":
        executar_confirmacao(chat_id, texto)
    elif comando == "/cancel":
        limpar_pendente()
        enviar(chat_id, "Pendência descartada. 👍")
    else:
        enviar(chat_id, "Comando não reconhecido.\n\n" + ajuda())


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

    try:
        tg("setMyCommands", commands=json.dumps([
            {"command": "status", "description": "containers, API, disco e RAM"},
            {"command": "alerts", "description": "Netdata + Uptime Kuma"},
            {"command": "ai", "description": "diagnostico com a IA local"},
            {"command": "fix", "description": "acoes permitidas"},
            {"command": "help", "description": "lista de comandos"},
        ]))
    except Exception as exc:  # noqa: BLE001
        log(f"aviso: nao consegui registrar os comandos no menu: {exc}")

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
