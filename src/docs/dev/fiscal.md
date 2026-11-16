# Módulo Fiscal — Regras de Negócio

Emissão de **NFC-e (modelo 65)** a partir do PDV, com configuração, diagnóstico de prontidão,
fila de envio e cancelamento.

## Visão geral

O módulo nasce **desligado**: a capability `fiscal.nfce` (beta) precisa ser ativada em
Configurações › Recursos. Emitir documento fiscal errado tem consequência legal — o caminho é
opt-in consciente.

O emitente usa os dados de `empresa.*` (já preenchidos na ativação). Segredos (CSC, senha do
certificado e token do emissor) ficam no **cofre** (`core/secrets`), nunca em `settings` —
porque `GET /api/settings` devolve todas as chaves e o backup manda o banco para a nuvem.

## Configuração

| Item | Onde fica | Observação |
| --- | --- | --- |
| Emitente (razão, CNPJ, IE, endereço) | `empresa.*` | Reaproveitado da ativação |
| Certificado A1 (.pfx) + senha | arquivo local + cofre | `fiscal.cert_*` para exibir; senha no cofre |
| CSC + ID do CSC | cofre (`fiscal.csc`) + `fiscal.id_csc` | Gera o QR Code da nota |
| Emissor (provider) + token | `fiscal.provider` + cofre | Integração de emissão |
| Série, CRT, CFOP, CSOSN/CST, origem | `fiscal.*` | Padrões do Simples Nacional |
| Ambiente | `fiscal.ambiente` | 1 = produção, 2 = homologação |
| `emitir_auto`, `pedir_cpf` | `fiscal.*` | Emissão automática e CPF no PDV |

O `ambiente` **nunca** cai em produção por omissão: sem valor gravado, fica homologação.
Trocar para produção passa por `promoteToProduction`, que exige uma emissão de teste
aprovada antes.

## Diagnóstico de prontidão

`checkReadiness` lista o que falta para emitir, cada pendência com o motivo e onde resolver:

- **Dados da empresa** (razão, CNPJ válido, IE, endereço, CEP, UF, município IBGE).
- **Certificado A1** (ausente/expirado = falha; a menos de 30 dias = aviso).
- **CSC** (e ID do CSC).
- **Emissor** (provider + token).
- **NCM nos produtos** — conta os produtos que podem virar item de nota e não têm NCM.
- **Ambiente** — informativo, nunca bloqueia.

`ready` = nenhum check em `fail`. `podeAtivarProducao` = pronto e já houve teste aprovado.

## NCM nos produtos

Precisa de NCM todo produto que pode virar linha de venda. Ficam **fora**: `servico` (é NFS-e
municipal) e o produto-pai de variações (linha de estrutura). Entram as variações filhas,
complementos, kits e componentes. A tela `/app/fiscal/produtos` permite preencher em lote.

## Emissão e cancelamento

- A emissão parte do PDV; o documento e a fila de envio ficam em `fiscal_documents`.
- `fiscal.emit` emite manualmente; `fiscal.cancel` cancela nota autorizada.
- **Cancelar a venda com nota viva é bloqueado** — o lojista cancela a nota primeiro
  (`hasLiveDocument`). Sem isso, sobraria uma NFC-e autorizada apontando para venda inexistente.

### Emissor simulado (homologação)

Enquanto não há integração com um emissor real, o provider `simulado` fecha o fluxo de
ponta a ponta sem tocar na SEFAZ:

1. `POST /api/fiscal/certificado/teste` gera um A1 autoassinado (titular `KURUK TESTE`) e
   grava a senha no cofre. É o mesmo caminho de `storeCertificate` do upload manual, então
   serve para testar leitura, validade e assinatura.
2. `PUT /api/fiscal/credenciais` grava `provider: "simulado"`. CSC e token não são exigidos;
   o QR Code usa um CSC de teste e o diagnóstico mostra os dois checks como `warn`.
3. `POST /api/fiscal/documentos/emitir` com `{ saleId }` reserva o próximo número, monta o
   XML 4.00, assina `infNFe` com RSA-SHA1, gera a chave de 44 dígitos e recebe do simulador
   `cStat 100` + protocolo. O XML autorizado vai para `storage/fiscal/AAAA/MM/<chave>.xml`.
4. `POST /api/fiscal/documentos/:id/cancelar` com `{ motivo }` gera o evento `110111`,
   assina e arquiva o XML de cancelamento.
5. `GET /api/fiscal/documentos/:id/xml` baixa o `nfeProc`; `?tipo=cancelamento` baixa o
   `procEventoNFe`.

O simulado **não emite em produção** (`ambiente 1`): o serviço recusa antes de reservar
número. A tela de notas mostra as vendas concluídas sem documento em
`GET /api/fiscal/documentos/vendas-disponiveis`, para não exigir que o lojista decore o
número da venda.

Para testar o fluxo inteiro pela linha de comando:

```bash
node scripts/kuruk test:fiscal-emissao
```

O teste cobre empresa, certificado de teste, diagnóstico, venda, emissão, digest/assinatura,
download do XML, rejeição simulada, nova tentativa, cancelamento e a trava de produção.

Para exercitar um `.pfx` real (ou o simulado de `doc/certificado`, quando você tiver a
senha) em vez do certificado gerado, informe o arquivo e a senha:

```bash
# PowerShell
$env:KURUK_TEST_CERT_PFX='doc/certificado/kuruk-teste.pfx'
$env:KURUK_TEST_CERT_PASSWORD='a-senha-do-arquivo'
node scripts/kuruk test:fiscal-emissao
```

### Certificado de teste x certificado real

O `.pfx` simulado pode ser enviado pela tela normal (`POST /api/fiscal/certificado`) quando
o lojista tem a senha. O botão **Gerar certificado de teste** é só um atalho para uma
instalação limpa; o certificado da empresa continua sendo obrigatório para emissão real.

## Sincronização

`fiscal_documents` **não** sincroniza: documento fiscal é arquivo do contribuinte naquela
máquina, e a numeração por série/ambiente não sobrevive a uma resolução de conflito
last-write-wins.

## Permissões e recursos

- `fiscal.config.view` / `fiscal.config.edit`, `fiscal.documents.view`, `fiscal.emit`,
  `fiscal.cancel`.
- Capability `fiscal.nfce` (beta) controla menu e telas.

## Arquivos-chave

- `src/modules/fiscal/services/config.ts` — configuração tipada e cofre.
- `src/modules/fiscal/services/certificate.ts` — leitura/validade do A1.
- `src/modules/fiscal/services/readiness.ts` — diagnóstico "o que falta para emitir".
- `src/modules/fiscal/controllers/FiscalController.ts` — rotas de emissão/fila.
