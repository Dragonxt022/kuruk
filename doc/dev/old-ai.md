# old-ai: assistente e vigilância do servidor OLD

Kit de operação do servidor `old` (100.87.5.89): alertas no Telegram, um
assistente de diagnóstico rodando localmente com Ollama e um watchdog de cron.

Tudo roda no usuário `bruno` (que está no grupo `docker`). Não precisa de root.

## Componentes

| Arquivo | Onde roda | Função |
| --- | --- | --- |
| `scripts/old-ai.sh` | `~/bin/old-ai` | diagnóstico: coleta estado e pergunta ao modelo local |
| `scripts/old-actions.sh` | `~/bin/old-actions.sh` | executor com **allowlist** de ações de manutenção |
| `scripts/old-watchdog.sh` | `~/bin/old-watchdog.sh` | checagens de cron + alerta no Telegram |
| `scripts/old-bot.py` | `~/bin/old-bot.py` | bot do Telegram (long polling) |
| `scripts/old-ai-install.sh` | — | instalador/atualizador (idempotente) |

Config em `~/etc/old-ai.env` (chmod 600), logs em `~/logs/old-ai/`.

## Alertas

Duas fontes complementares, ambas entregando no mesmo chat do Telegram:

- **Uptime Kuma** (`http://100.87.5.89:3001`): 5 monitores — Página Pública,
  Portainer, Cloudflare Tunnel, Netdata e `KURUK - API Health`. Todos vinculados
  ao canal `MAIA` (Telegram), que é o canal padrão.
- **Netdata** (`http://100.87.5.89:19999`): alarmes de sistema (disco, RAM, CPU,
  certificados, containers). Config em
  `/etc/netdata/health_alarm_notify.conf` dentro do volume
  `netdata_netdata_config` (email desligado, Telegram ligado).

O **watchdog** cobre o que os dois não veem: daemon do Docker fora, container
parado, loop de restart, backup diário atrasado (>26 h), certificado público
vencendo em <14 dias e Ollama fora do ar. Cada problema alerta no máximo uma vez
a cada 30 minutos.

## Ollama

Container `ollama` (`restart: unless-stopped`), escutando **apenas** em
`127.0.0.1:11434`:

```sh
docker run -d --name ollama --restart unless-stopped \
  -p 127.0.0.1:11434:11434 -v ollama-data:/root/.ollama \
  --cpus=1.5 --memory=3g --memory-swap=3g \
  -e OLLAMA_NUM_PARALLEL=1 -e OLLAMA_MAX_LOADED_MODELS=1 \
  -e OLLAMA_MAX_QUEUE=8 -e OLLAMA_KEEP_ALIVE=5m ollama/ollama:latest
```

`NUM_PARALLEL=1` + `MAX_QUEUE=8` é o "trabalha em fila": uma inferência por vez,
no máximo 8 esperando (a nona é recusada em vez de derrubar o servidor). O limite
de CPU/RAM impede que a inferência consuma o que o cloud e o MySQL precisam.

Modelos: `qwen3:0.6b` (rápido, raso) e `qwen3:1.7b` (padrão do assistente).
Medido no Celeron 6305: ~22 tok/s no 0.6b e ~8 tok/s no 1.7b.

## Uso

```sh
old-ai                                   # diagnóstico geral
old-ai "o site está lento, o que checar?" # pergunta específica
OLD_AI_MODEL=qwen3:0.6b old-ai           # resposta mais rápida
old-actions.sh list                      # ações permitidas
old-actions.sh status                    # só leitura
```

O script monta um **veredito por regras** antes de chamar o modelo (containers,
conexões do túnel, HTTP da API, monitores DOWN, alarmes do Netdata, erros
classificados). O modelo só relata esse veredito — é o que evita um 1.7b
"inventar risco" ao ver uma linha de log.

Erros de log são classificados assim:

- `unexpected EOF` / `stream canceled` em `/api/commands/events`: desconexão do
  SSE que os desktops mantêm aberto. Normal.
- `timeout: no recent network activity` / `Failed to dial a quic`: o cloudflared
  reconectando ao edge. Só é problema se `readyConnections` cair abaixo de 2.
- qualquer outro: entra como "para investigar".

No Telegram (bot `MAIA`): `/status`, `/alerts`, `/ai <pergunta>`, `/fix`,
`/confirm <código>`, `/cancel`.

## Segurança

- O modelo **nunca executa nada**. Ele lê um resumo do estado e devolve texto.
- Ações de manutenção passam por `old-actions.sh`, que valida o nome contra uma
  lista fixa (sem argumentos livres, sem shell).
- Pelo Telegram, a ação só roda depois de `/confirm` com código de uso único e
  validade de 5 minutos.
- O bot responde apenas ao `ALLOWED_CHAT_ID` configurado.
- Uma única instância: `old-bot.py` segura um `flock` e sai se já houver outra.
- Ao iniciar, o bot descarta o backlog de updates (um restart não reexecuta
  comandos antigos).

## Instalar / atualizar

```sh
scp scripts/old-ai.sh scripts/old-actions.sh scripts/old-watchdog.sh \
    scripts/old-bot.py scripts/old-ai-install.sh bruno@100.87.5.89:/tmp/old-ai-src/
ssh bruno@100.87.5.89 'cd /tmp/old-ai-src && sed -i "s/\r$//" * && bash old-ai-install.sh'
```

O instalador copia os binários, regrava `~/etc/old-ai.env` a partir do canal do
Kuma e atualiza o bloco `# >>> old-ai` do crontab.

## Cron

```cron
*/5 * * * * ~/bin/old-watchdog.sh >> ~/logs/old-ai/watchdog.log 2>&1
* * * * *   pgrep -f "[o]ld-bot.py" >/dev/null || setsid ~/bin/old-bot.py >> ~/logs/old-ai/bot.log 2>&1 < /dev/null &
```

O bot é supervisionado pelo próprio cron (se morrer, volta em até 1 minuto).

## Limitações conhecidas

- Rodar `qwen3:1.7b` na CPU ocupa ~2,1 GB e leva ~50 s por resposta; é para
  diagnóstico ocasional, não para uso contínuo.
- O `qwen3:0.6b` erra detalhes (chegou a sugerir `fdisk` para uso de disco).
  Use o 1.7b quando a resposta importar.
- Sem claim no Netdata Cloud: os alarmes ficam só locais (e no Telegram).
