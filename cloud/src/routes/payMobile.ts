import { Router } from 'express';
import { requireMobileAuth, type MobileRequest } from '../mobileAuth';
import { dataFreshness } from '../mobileData';
import {
  PayError, buildPayAuthUrl, cancelPayOrder, createPayOAuthState, createPayOrder,
  disconnectPayAccount, friendlyPayMessage, getCompanyPayEnvironment, getPayAccount,
  getPayOrderForCompany, getPayTerminals, listPayOrders, loadPayAppSettings,
  loadPayAppSettingsView, normalizePayEnvironment, payEnvironmentConfigured,
  refreshPayOrderIfStale, refundPayOrder, serializePayOrder, setCompanyPayEnvironment,
  setDefaultPayTerminal, simulatePayOrderEvent, syncPayTerminals,
  PAY_TEST_VIRTUAL_TERMINAL_ID, type PayEnvironment,
} from '../pay';

/**
 * Kuruk Pay no Kuruk Web (`/m/pay`) — a configuração que o lojista faz no celular.
 *
 * Mesma sessão do painel (`company_mobile_grants`): nada de senha nova. O OAuth é
 * iniciado por um POST autenticado que grava o `state`; o retorno do Mercado Pago cai
 * em `/api/pay/oauth/callback` e volta para cá.
 */
const router = Router();

router.use(requireMobileAuth);

/** Quem pode abrir a tela. Operador de caixa vê, mas não mexe na conta. */
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

function bloquear(
  req: MobileRequest,
  res: import('express').Response,
  tipo: 'ver' | 'gerenciar' | 'cobrar' = 'ver',
): boolean {
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
  const environment = req.query.environment
    ? normalizePayEnvironment(req.query.environment)
    : await getCompanyPayEnvironment(companyUuid);
  const account = await getPayAccount(companyUuid, environment);
  const app = await loadPayAppSettingsView();
  const envConfigured = await payEnvironmentConfigured(environment);
  const terminals = account ? await getPayTerminals(companyUuid, account.environment) : [];
  const orders = await listPayOrders(companyUuid, environment, 12);

  res.render('pay-mobile', {
    titulo: 'Kuruk Pay',
    grant: req.grant!,
    fresh: await dataFreshness(companyUuid),
    ativo: 'pay',
    app,
    envConfigured,
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
      virtual: t.terminal_id === PAY_TEST_VIRTUAL_TERMINAL_ID,
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

/** Troca o ambiente da loja com um clique (teste <-> produção). */
router.post('/ambiente', async (req: MobileRequest, res) => {
  if (bloquear(req, res, 'gerenciar')) return;
  const environment = normalizePayEnvironment((req.body ?? {}).environment);
  if (!(await payEnvironmentConfigured(environment))) {
    res.redirect('/m/pay?erro=' + encodeURIComponent(
      `O suporte ainda não cadastrou as credenciais de ${environment === 'teste' ? 'teste' : 'produção'}.`,
    ));
    return;
  }
  await setCompanyPayEnvironment(req.grant!.companyUuid, environment);
  res.redirect('/m/pay?ok=' + encodeURIComponent(
    `Ambiente de ${environment === 'teste' ? 'teste' : 'produção'} ativado.`,
  ));
});

router.post('/conectar', async (req: MobileRequest, res) => {
  if (bloquear(req, res, 'gerenciar')) return;
  const environment = normalizePayEnvironment((req.body ?? {}).environment);
  const app = await loadPayAppSettings(environment);
  if (!app.clientId || !app.clientSecret) {
    res.redirect('/m/pay?erro=' + encodeURIComponent(
      `O suporte ainda não cadastrou as credenciais de ${environment === 'teste' ? 'teste' : 'produção'}.`,
    ));
    return;
  }
  await setCompanyPayEnvironment(req.grant!.companyUuid, environment);
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
  const companyUuid = req.grant!.companyUuid;
  const environment = await getCompanyPayEnvironment(companyUuid);
  const account = await getPayAccount(companyUuid, environment);
  if (!account) {
    res.redirect('/m/pay?erro=' + encodeURIComponent('Conecte a conta Mercado Pago primeiro.'));
    return;
  }
  try {
    const terminals = await syncPayTerminals(companyUuid, environment);
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
  const companyUuid = req.grant!.companyUuid;
  const environment = await getCompanyPayEnvironment(companyUuid);
  const account = await getPayAccount(companyUuid, environment);
  if (!account) {
    res.redirect('/m/pay?erro=' + encodeURIComponent('Conecte a conta Mercado Pago primeiro.'));
    return;
  }
  const terminalId = String((req.body ?? {}).terminalId ?? '').trim();
  const ok = terminalId
    ? await setDefaultPayTerminal(companyUuid, environment, terminalId)
    : false;
  res.redirect('/m/pay?' + (ok
    ? 'ok=' + encodeURIComponent('Terminal padrão atualizado.')
    : 'erro=' + encodeURIComponent('Escolha um terminal válido.')));
});

router.post('/cobrar', async (req: MobileRequest, res) => {
  if (bloquear(req, res, 'cobrar')) return;
  const companyUuid = req.grant!.companyUuid;
  const environment = await getCompanyPayEnvironment(companyUuid);
  const account = await getPayAccount(companyUuid, environment);
  if (!account) {
    res.redirect('/m/pay?erro=' + encodeURIComponent('Conecte a conta Mercado Pago primeiro.'));
    return;
  }
  const amountCents = parseAmountCents((req.body ?? {}).amount);
  if (amountCents < 1) {
    res.redirect('/m/pay?erro=' + encodeURIComponent('Informe um valor válido para a cobrança.'));
    return;
  }
  try {
    const order = await createPayOrder({
      companyUuid,
      environment,
      origin: 'teste',
      amountCents,
      description: String((req.body ?? {}).description ?? '').trim() || 'Cobrança de teste Kuruk Pay',
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
    res.status(404).json({ error: 'Cobrança não encontrada.' });
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
    res.redirect('/m/pay?erro=' + encodeURIComponent('Cobrança não encontrada.'));
    return;
  }
  try {
    await cancelPayOrder(uuid);
    res.redirect('/m/pay?ok=' + encodeURIComponent('Cobrança cancelada.'));
  } catch (e) {
    res.redirect('/m/pay?erro=' + encodeURIComponent(friendlyPayMessage(e)));
  }
});

router.post('/pedidos/:uuid/estornar', async (req: MobileRequest, res) => {
  if (bloquear(req, res, 'gerenciar')) return;
  const uuid = String(req.params.uuid);
  const owner = await getPayOrderForCompany(req.grant!.companyUuid, uuid);
  if (!owner) {
    res.redirect('/m/pay?erro=' + encodeURIComponent('Cobrança não encontrada.'));
    return;
  }
  try {
    await refundPayOrder(uuid);
    res.redirect('/m/pay?ok=' + encodeURIComponent('Cobrança estornada.'));
  } catch (e) {
    res.redirect('/m/pay?erro=' + encodeURIComponent(friendlyPayMessage(e)));
  }
});

/** Só no ambiente de teste: conclui a order no terminal virtual do Mercado Pago. */
router.post('/pedidos/:uuid/simular', async (req: MobileRequest, res) => {
  if (bloquear(req, res, 'cobrar')) return;
  const uuid = String(req.params.uuid);
  const owner = await getPayOrderForCompany(req.grant!.companyUuid, uuid);
  if (!owner) {
    res.redirect('/m/pay?erro=' + encodeURIComponent('Cobrança não encontrada.'));
    return;
  }
  try {
    await simulatePayOrderEvent(uuid, 'processed');
    res.redirect('/m/pay?pedido=' + encodeURIComponent(uuid) + '&ok=' + encodeURIComponent('Aprovação simulada. Aguardando o Mercado Pago confirmar.'));
  } catch (e) {
    res.redirect('/m/pay?erro=' + encodeURIComponent(friendlyPayMessage(e)));
  }
});

export default router;
