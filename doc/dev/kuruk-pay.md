# Kuruk Pay — maquininha Point (conta Mercado Pago do lojista)

Produto **separado** do gateway de assinatura do Kuruk (`cloud/src/gateway.ts`). Aqui:

- o dinheiro cai na conta Mercado Pago **do lojista**;
- o lojista conecta a **própria conta** por OAuth;
- o Kuruk só envia a cobrança para o terminal **Point** (Orders API) e recebe o resultado.

Não confundir com:

| Assinatura do Kuruk | Kuruk Pay |
| --- | --- |
| Conta Mercado Pago da Kuruk | Conta Mercado Pago da loja |
| Cobra o plano do cliente | Cobra o cliente final da loja |
| `charges` / `subscriptions` | `pay_*` |
| Access Token fixo no servidor | OAuth por empresa |

## Como funciona

1. O suporte salva o **Client ID/Secret** do aplicativo “Kuruk-Pay” em `/admin/pay`.
2. O lojista abre **Kuruk Pay** no app (`/app/kuruk-pay`) ou no Kuruk Web (`/m/pay`) e clica em **Conectar Mercado Pago**.
3. O cloud grava um `state`, manda o navegador para `auth.mercadopago.com.br`, recebe o `code` em
   `/api/pay/oauth/callback` e troca por `access_token` + `refresh_token`.
4. Os terminais Point da conta são sincronizados (`GET /terminals/v1/list`) e o lojista escolhe o padrão.
5. No PDV, ao lançar um pagamento em **débito/crédito**, o operador marca “Cobrar na maquininha Point”.
   O app chama o cloud, que cria uma order `type: point`; o app faz polling até aprovar/recusar.
6. O pagamento aprovado entra na venda como cartão, com `point_order_uuid`, bandeira e parcelas.

## Configuração do aplicativo no Mercado Pago

No painel de aplicações do Mercado Pago, no app **Kuruk-Pay**:

- **URL de redirecionamento**: exatamente `https://kuruk.com.br/api/pay/oauth/callback`
  (ou o valor mostrado em `/admin/pay`; pode ser sobrescrito por `MP_PAY_REDIRECT_URL`).
- **Webhook**: `https://kuruk.com.br/api/webhooks/mercadopago`, evento **order**.
- **Client ID** e **Client Secret**: colar em `/admin/pay` (o secret fica no servidor e nunca
  volta para a tela).

Fallback por variáveis de ambiente do cloud: `MP_PAY_CLIENT_ID`, `MP_PAY_CLIENT_SECRET`,
`MP_PAY_WEBHOOK_SECRET`, `MP_PAY_REDIRECT_URL`.

## Banco (cloud)

Migration `0057_kuruk_pay`:

- `pay_oauth_states` — `state` do OAuth (15 min).
- `pay_accounts` — token/refresh por empresa + ambiente; terminal padrão.
- `pay_terminals` — terminais Point sincronizados.
- `pay_orders` — cobranças enviadas (auditoria e reconciliação).

No desktop, a migration `0097_sale_payments_point` adiciona ao `sale_payments`:
`point_order_uuid`, `point_brand`, `point_installments`, `point_payment_type`.

## Endpoints

### Cloud — `/api/pay` (licença da empresa)

| Método | Rota | Uso |
| --- | --- | --- |
| GET | `/account` | estado da conexão + terminais |
| POST | `/account/connect` | devolve a URL do OAuth |
| POST | `/account/disconnect` | remove token da empresa |
| GET | `/terminals` | terminais salvos |
| POST | `/terminals/sync` | relê no Mercado Pago |
| POST | `/terminals/default` | escolhe o terminal padrão |
| GET | `/orders` | histórico |
| POST | `/orders` | cria uma order no terminal |
| GET | `/orders/:uuid` | relê o estado |
| POST | `/orders/:uuid/cancel` | cancela no terminal |
| POST | `/orders/:uuid/refund` | estorna |

### Cloud — público

- `GET /api/pay/oauth/callback` — retorno do OAuth (casa pelo `state`).
- `GET /pay/conectado` — página de sucesso.
- `POST /api/webhooks/mercadopago` — trata `type: order` com a assinatura do app Kuruk Pay.

### Kuruk Web — `/m/pay`

Telas e formulários para o lojista conectar, sincronizar, escolher terminal e fazer cobrança de teste.
Permissão: `kurukpay.settings.manage`, `finance.paymethods.edit` ou `store.sales.create`.

### App — `/app/kuruk-pay` e `/api/kuruk-pay`

O módulo `src/modules/kuruk-pay` só repassa ao cloud com as credenciais da licença.
`GET /api/kuruk-pay/point-config` é a versão enxuta usada pelo PDV (sem exigir permissão de configuração).

## Segurança

- Token e refresh token nunca saem do servidor.
- O webhook **não é fonte da verdade**: o pedido é relido em `GET /v1/orders/{id}` com o token da empresa.
- O `state` é de uso único, expira em 15 minutos e identifica a empresa/ambiente.
- Estorno/cancelamento também são reconferidos na API.

## Limitações conhecidas

- Um terminal Point precisa estar vinculado à conta e no modo `PDV`/integrado.
- Não há fila offline no PDV: sem nuvem, a opção “maquininha” não aparece e a venda pode ser
  lançada como cartão manual (comportamento antigo).
- Se o Mercado Pago aprovar a cobrança e a venda falhar depois (ex.: caixa fechado), o pedido
  aparece em **Kuruk Pay → Cobranças recentes** para estorno manual.
- O cancelamento da venda estorna a cobrança automaticamente; **devolução parcial** não —
  nesse caso, estorne manualmente em Kuruk Pay → Cobranças recentes.
