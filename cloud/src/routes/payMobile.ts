import { Router } from 'express';
import { requireMobileAuth, type MobileRequest } from '../mobileAuth';
import { dataFreshness } from '../mobileData';
import {
  PayError, buildPayAuthUrl, cancelPayOrder, createPayOAuthState, createPayOrder,
  disconnectPayAccount, friendlyPayMessage, getActivePayAccount, getPayOrderForCompany,
  getPayTerminals, listPayOrders, loadPayAppSettings, loadPayAppSettingsView,
  normalizePayEnvironment, refreshPayOrderIfStale, refundPayOrder, serializePayOrder,
  setDefaultPayTerminal, syncPayTerminals, type PayEnvironment,
} from '../pay';

/**
 * Kuruk Pay no Kuruk Web (`/m/pay`) â€” a configuraÃ§Ã£o que o lojista faz no celular.
 *
 * Mesma sessÃ£o do painel (`company_mobile_grants`): nada de senha nova. O OAuth Ã©
 * iniciado por um POST autenticado que grava o `state`; o retorno do Mercado Pago cai
 * em `/api/pay/oauth/callback` e volta para cÃ¡.
 */
const router = Router();

router.use(requireMobileAuth);

/** Quem pode abrir a tela. Operador de caixa vÃª, mas nÃ£o mexe na conta. */
function podeVer(req: MobileRequest): boolean {
  const p = req.grant!.permissions;
  return p.includes('kurukpay.settings.manage')
    || p.includes('finance.paymethods.edit')
    || p.includes('store.sales.create');
}

function podeGerenciar(req: MobileRequest): boolean {
  const p = req.grant!.permissions;
  return p.includes('kurukpay.settings.manage') || p.includes('finance.paymethods.edit');
}

function podeCobrar(req: MobileRequest): boolean {
  return podeGerenciar(req) || req.grant!.permissions.includes('store.sales.create');
}

function bloquear(req: MobileRequest, res: import('express').Response, tipo: 'ver' | 'gerenciar' | 'cobrar' = 'ver'): boolean {
  const ok = tipo === 'gerenciar' ? podeGerenciar(req)
    : tipo === 'cobrar' ? podeCobrar(req)
      : podeVer(req);
  if (ok) return false;
  res.redirect('/m');
  return true;
}

function parseAmountCents(value: unknown): number {
  const raw = String(value ?? '').replace(/[^\d,.-]/g, '');
  const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
  const n = Number(normalized);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function brl(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

router.get('/', async (req: MobileRequest, res) => {
  if (bloquear(req, res)) return;
  const companyUuid = req.grant!.companyUuid;
  const account = await getActivePayAccount(companyUuid);
  const app = await loadPayAppSettingsView();
  const environment: PayEnvironment = account?.environment
    ?? normalizePayEnvironment(req.query.environment);
  const terminals = account ? await getPayTerminals(companyUuid, account.environment) : [];
  const orders = await listPayOrders(companyUuid, null, 12);

  res.render('pay-mobile', {
    titulo: 'Kuruk Pay',
    grant: req.grant!,
    fresh: await dataFreshness(companyUuid),
    ativo: 'pay',
    app,
    account: account ? {
      environment: account.environment,
      email: account.email,
      nickname: account.nickname,
      liveMode: account.live_mode === 1,
      status: account.status,
      lastError: account.last_error,
      connectedAt: account.connected_at ? new Date(account.connected_at as string).toISOString() : null,
      defaultTerminalId: account.default_terminal_id,
    } : null,
    environment,
    terminals: terminals.map((t) => ({
      terminalId: t.terminal_id,
      label: t.name || `Point ${t.terminal_id}`,
      posId: t.pos_id,
      storeId: t.store_id,
      operatingMode: t.operating_mode,
      isDefault: t.terminal_id === account?.default_terminal_id,
    })),
    orders: orders.map(serializePayOrder),
    pedido: typeof req.query.pedido === 'string' ? req.query.pedido : null,
    ok: typeof req.query.ok === 'string' ? req.query.ok : null,
    erro: typeof req.query.erro === 'string' ? req.query.erro : null,
    pay: typeof req.query.pay === 'string' ? req.query.pay : null,
    canManage: podeGerenciar(req),
    canCharge: podeCobrar(req),
    brl,
  });
});

router.post('/conectar', async (req: MobileRequest, res) => {
  if (bloquear(req, res, 'gerenciar')) return;
  const app = await loadPayAppSettings();
  if (!app.clientId || !app.clientSecret) {
    res.redirect('/m/pay?erro=' + encodeURIComponent('O Kuruk Pay ainda nÃ£o foi configurado pelo suporte.'));
    return;
  }
  const environment = normalizePayEnvironment((req.body ?? {}).environment);
  const state = await createPayOAuthState(req.grant!.companyUuid, environment, '/m/pay');
  res.redirect(buildPayAuthUrl(state, app.clientId));
});

router.post('/desconectar', async (req: MobileRequest, res) => {
  if (bloquear(req, res, 'gerenciar')) return;
  const environment = normalizePayEnvironment((req.body ?? {}).environment);
  await disconnectPayAccount(req.grant!.companyUuid, environment);
  res.redirect('/m/pay?ok=' + encodeURIComponent('Conta Mercado Pago desconectada.'));
});

router.post('/terminais/sincronizar', async (req: MobileRequest, res) => {
  if (bloquear(req, res, 'gerenciar')) return;
  const account = await getActivePayAccount(req.grant!.companyUuid);
  if (!account) {
    res.redirect('/m/pay?erro=' + encodeURIComponent('Conecte a conta Mercado Pago primeiro.'));
    return;
  }
  try {
    const terminals = await syncPayTerminals(req.grant!.companyUuid, account.environment);
    res.redirect('/m/pay?ok=' + encodeURIComponent(
      terminals.length
        ? `${terminals.length} terminal(is) sincronizado(s).`
        : 'Nenhum terminal Point encontrado nesta conta.',
    ));
  } catch (e) {
    res.redirect('/m/pay?erro=' + encodeURIComponent(friendlyPayMessage(e)));
  }
});

router.post('/terminal-padrao', async (req: MobileRequest, res) => {
  if (bloquear(req, res, 'gerenciar')) return;
  const account = await getActivePayAccount(req.grant!.companyUuid);
  if (!account) {
    res.redirect('/m/pay?erro=' + encodeURIComponent('Conecte a conta Mercado Pago primeiro.'));
    return;
  }
  const terminalId = String((req.body ?? {}).terminalId ?? '').trim();
  const ok = terminalId
    ? await setDefaultPayTerminal(req.grant!.companyUuid, account.environment, terminalId)
    : false;
  res.redirect('/m/pay?' + (ok
    ? 'ok=' + encodeURIComponent('Terminal padrÃ£o atualizado.')
    : 'erro=' + encodeURIComponent('Escolha um terminal vÃ¡lido.')));
});

router.post('/cobrar', async (req: MobileRequest, res) => {
  if (bloquear(req, res, 'cobrar')) return;
  const account = await getActivePayAccount(req.grant!.companyUuid);
  if (!account) {
    res.redirect('/m/pay?erro=' + encodeURIComponent('Conecte a conta Mercado Pago primeiro.'));
    return;
  }
  const amountCents = parseAmountCents((req.body ?? {}).amount);
  if (amountCents < 1) {
    res.redirect('/m/pay?erro=' + encodeURIComponent('Informe um valor vÃ¡lido para a cobranÃ§a.'));
    return;
  }
  try {
    const order = await createPayOrder({
      companyUuid: req.grant!.companyUuid,
      environment: account.environment,
      origin: 'teste',
      amountCents,
      description: String((req.body ?? {}).description ?? '').trim() || 'CobranÃ§a de teste Kuruk Pay',
      terminalId: String((req.body ?? {}).terminalId ?? '').trim() || account.default_terminal_id,
    });
    res.redirect('/m/pay?pedido=' + encodeURIComponent(order.uuid));
  } catch (e) {
    res.redirect('/m/pay?erro=' + encodeURIComponent(friendlyPayMessage(e)));
  }
});

router.get('/pedidos/:uuid', async (req: MobileRequest, res) => {
  if (bloquear(req, res, 'cobrar')) return;
  const uuid = String(req.params.uuid);
  const owner = await getPayOrderForCompany(req.grant!.companyUuid, uuid);
  if (!owner) {
    res.status(404).json({ error: 'CobranÃ§a nÃ£o encontrada.' });
    return;
  }
  try {
    const row = await refreshPayOrderIfStale(uuid);
    res.json({ order: row ? serializePayOrder(row) : null });
  } catch (e) {
    const status = e instanceof PayError && e.status >= 400 && e.status < 600 ? e.status : 502;
    res.status(status).json({ error: friendlyPayMessage(e) });
  }
});

router.post('/pedidos/:uuid/cancelar', async (req: MobileRequest, res) => {
  if (bloquear(req, res, 'cobrar')) return;
  const uuid = String(req.params.uuid);
  const owner = await getPayOrderForCompany(req.grant!.companyUuid, uuid);
  if (!owner) {
    res.redirect('/m/pay?erro=' + encodeURIComponent('CobranÃ§a nÃ£o encontrada.'));
    return;
  }
  try {
    await cancelPayOrder(uuid);
    res.redirect('/m/pay?ok=' + encodeURIComponent('CobranÃ§a cancelada.'));
  } catch (e) {
    res.redirect('/m/pay?erro=' + encodeURIComponent(friendlyPayMessage(e)));
  }
});

router.post('/pedidos/:uuid/estornar', async (req: MobileRequest, res) => {
  if (bloquear(req, res, 'gerenciar')) return;
  const uuid = String(req.params.uuid);
  const owner = await getPayOrderForCompany(req.grant!.companyUuid, uuid);
  if (!owner) {
    res.redirect('/m/pay?erro=' + encodeURIComponent('CobranÃ§a nÃ£o encontrada.'));
    return;
  }
  try {
    await refundPayOrder(uuid);
    res.redirect('/m/pay?ok=' + encodeURIComponent('CobranÃ§a estornada.'));
  } catch (e) {
    res.redirect('/m/pay?erro=' + encodeURIComponent(friendlyPayMessage(e)));
  }
});

export default router;

