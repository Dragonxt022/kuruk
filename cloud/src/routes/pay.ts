import { Router } from 'express';
import { requireCompanyAuth, type AuthedRequest } from '../auth';
import {
  PayError, buildPayAuthUrl, cancelPayOrder, consumePayOAuthState, createPayOAuthState,
  createPayOrder, disconnectPayAccount, exchangePayCode, fetchPayMe, friendlyPayMessage,
  getCompanyPayEnvironment, getPayAccount, getPayOrderForCompany,
  getPayTerminals, listPayOrders, loadPayAppSettings, loadPayAppSettingsView,
  normalizePayEnvironment, payCallbackUrl, payEnvironmentConfigured, refreshPayOrderIfStale,
  refundPayOrder, savePayAccount, serializePayOrder, setCompanyPayEnvironment,
  setDefaultPayTerminal, simulatePayOrderEvent, syncPayTerminals,
  PAY_TEST_VIRTUAL_TERMINAL_ID,
  type PayEnvironment, type PayOrderOrigin, type PayTerminalRow,
} from '../pay';

/**
 * API do Kuruk Pay para o desktop (autenticada pela licença da empresa).
 *
 * O app NUNCA fala com o Mercado Pago: ele pede uma cobrança aqui e recebe o estado do
 * pedido. O token da conta do lojista fica só no servidor.
 *
 * O callback do OAuth é a única rota pública do arquivo: o Mercado Pago redireciona o
 * navegador para cá sem cabeçalhos da licença. A empresa é identificada pelo `state`
 * gravado antes de mandar o lojista para o site do MP.
 */
const router = Router();

function fail(res: import('express').Response, error: unknown): void {
  const status = error instanceof PayError && error.status >= 400 && error.status < 600
    ? error.status
    : 502;
  res.status(status).json({ error: friendlyPayMessage(error) });
}

function safeReturnUrl(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (raw.startsWith('/') && !raw.startsWith('//') && raw.length <= 300) return raw;
  return '/pay/conectado?origem=desktop';
}

function appendQuery(url: string, key: string, value: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

function environmentFrom(value: unknown): PayEnvironment {
  return normalizePayEnvironment(value);
}

function terminalView(t: PayTerminalRow, defaultId: string | null) {
  return {
    terminalId: t.terminal_id,
    name: t.name,
    label: t.name || `Point ${t.terminal_id}`,
    posId: t.pos_id,
    storeId: t.store_id,
    operatingMode: t.operating_mode,
    isDefault: t.terminal_id === defaultId,
    virtual: t.terminal_id === PAY_TEST_VIRTUAL_TERMINAL_ID,
    syncedAt: new Date(t.synced_at as string).toISOString(),
  };
}

// ─────────────────────────── OAuth (público) ───────────────────────────

router.get('/oauth/callback', async (req, res) => {
  const code = String(req.query.code ?? '').trim();
  const state = String(req.query.state ?? '').trim();
  const mpError = String(req.query.error ?? '').trim();

  const saved = await consumePayOAuthState(state);
  if (!saved) {
    res.redirect('/pay/conectado?erro=' + encodeURIComponent('A autorização expirou. Comece novamente pelo Kuruk.'));
    return;
  }
  const returnUrl = safeReturnUrl(saved.return_url);

  if (mpError || !code) {
    // `access_denied` é o lojista clicando em "cancelar" no Mercado Pago; qualquer outro
    // erro (redirect_uri divergente, app desligado) é falha de configuração e merece a
    // tela de erro, não a de cancelamento.
    res.redirect(appendQuery(returnUrl, 'pay', mpError === 'access_denied' ? 'cancelado' : 'erro'));
    return;
  }

  try {
    const token = await exchangePayCode(code, saved.environment);
    const me = await fetchPayMe(token.access_token!);
    await savePayAccount(saved.company_uuid, saved.environment, token, me);
    // A empresa passa a operar no ambiente que acabou de autorizar.
    await setCompanyPayEnvironment(saved.company_uuid, saved.environment);
    // Sincronizar já deixa a tela pronta; se falhar, o botão "Sincronizar" resolve.
    try {
      await syncPayTerminals(saved.company_uuid, saved.environment);
    } catch (e) {
      console.error('[pay] conta conectada, mas falha ao listar terminais', {
        companyUuid: saved.company_uuid, erro: (e as Error).message,
      });
    }
    res.redirect(appendQuery(returnUrl, 'pay', 'ok'));
  } catch (e) {
    console.error('[pay] falha ao concluir OAuth', {
      companyUuid: saved.company_uuid, erro: (e as Error).message,
    });
    res.redirect(appendQuery(returnUrl, 'pay', 'erro'));
  }
});

// ─────────────────────────── Conta ───────────────────────────

router.get('/account', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const companyUuid = req.companyUuid!;
  const activeEnv = req.query.environment
    ? environmentFrom(req.query.environment)
    : await getCompanyPayEnvironment(companyUuid);
  const account = await getPayAccount(companyUuid, activeEnv);
  const app = await loadPayAppSettingsView();
  const configured = await payEnvironmentConfigured(activeEnv);

  if (!account) {
    res.json({
      configured,
      connected: false,
      environment: activeEnv,
      defaultEnvironment: app.defaultEnvironment,
      callbackUrl: app.callbackUrl,
      environments: app.environments.map((e) => ({ environment: e.environment, configured: e.configured })),
      account: null,
      terminals: [],
      defaultTerminalId: null,
    });
    return;
  }

  const terminals = await getPayTerminals(companyUuid, account.environment);
  res.json({
    configured,
    connected: Boolean(account.access_token),
    environment: account.environment,
    defaultEnvironment: app.defaultEnvironment,
    callbackUrl: app.callbackUrl,
    environments: app.environments.map((e) => ({ environment: e.environment, configured: e.configured })),
    account: {
      environment: account.environment,
      userId: account.mp_user_id,
      nickname: account.nickname,
      email: account.email,
      liveMode: account.live_mode === 1,
      status: account.status,
      lastError: account.last_error,
      connectedAt: account.connected_at ? new Date(account.connected_at as string).toISOString() : null,
    },
    terminals: terminals.map((t) => terminalView(t, account.default_terminal_id)),
    defaultTerminalId: account.default_terminal_id,
  });
});

/** Troca o ambiente da empresa com um clique (teste <-> produção). */
router.post('/environment', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const environment = environmentFrom(body.environment);
  // Não deixa trocar para um ambiente cujo aplicativo ainda não tem credenciais.
  if (!(await payEnvironmentConfigured(environment))) {
    res.status(400).json({
      error: `As credenciais de ${environment === 'teste' ? 'teste' : 'produção'} do Kuruk Pay ainda não foram cadastradas no servidor.`,
    });
    return;
  }
  await setCompanyPayEnvironment(req.companyUuid!, environment);
  res.json({ ok: true, environment });
});

router.post('/account/connect', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const environment = environmentFrom(body.environment);
  const app = await loadPayAppSettings(environment);
  if (!app.clientId || !app.clientSecret) {
    res.status(400).json({
      error: `As credenciais de ${environment === 'teste' ? 'teste' : 'produção'} do Kuruk Pay ainda não foram cadastradas no servidor.`,
    });
    return;
  }
  await setCompanyPayEnvironment(req.companyUuid!, environment);
  const state = await createPayOAuthState(req.companyUuid!, environment, safeReturnUrl(body.returnUrl));
  res.json({ url: buildPayAuthUrl(state, app.clientId), state, environment, callbackUrl: payCallbackUrl() });
});

router.post('/account/disconnect', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const environment = environmentFrom((req.body ?? {}).environment);
  const removed = await disconnectPayAccount(req.companyUuid!, environment);
  res.json({ ok: true, removed });
});

// ─────────────────────────── Terminais ───────────────────────────

router.get('/terminals', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const environment = req.query.environment
    ? environmentFrom(req.query.environment)
    : await getCompanyPayEnvironment(req.companyUuid!);
  const account = await getPayAccount(req.companyUuid!, environment);
  if (!account) {
    res.json({ terminals: [], defaultTerminalId: null, environment });
    return;
  }
  const terminals = await getPayTerminals(req.companyUuid!, account.environment);
  res.json({
    environment: account.environment,
    terminals: terminals.map((t) => terminalView(t, account.default_terminal_id)),
    defaultTerminalId: account.default_terminal_id,
  });
});

router.post('/terminals/sync', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const environment = body.environment
    ? environmentFrom(body.environment)
    : await getCompanyPayEnvironment(req.companyUuid!);
  const account = await getPayAccount(req.companyUuid!, environment);
  if (!account) {
    res.status(400).json({ error: 'Conecte a conta Mercado Pago antes de sincronizar os terminais.' });
    return;
  }
  try {
    const terminals = await syncPayTerminals(req.companyUuid!, environment);
    const updated = await getPayAccount(req.companyUuid!, environment);
    res.json({
      ok: true,
      environment,
      count: terminals.length,
      terminals: terminals.map((t) => ({
        terminalId: t.terminalId,
        label: t.name || `Point ${t.terminalId}`,
        posId: t.posId,
        storeId: t.storeId,
        operatingMode: t.operatingMode,
        virtual: t.terminalId === PAY_TEST_VIRTUAL_TERMINAL_ID,
      })),
      defaultTerminalId: updated?.default_terminal_id ?? null,
    });
  } catch (e) {
    fail(res, e);
  }
});

router.post('/terminals/default', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const environment = environmentFrom(body.environment);
  const terminalId = String(body.terminalId ?? '').trim();
  if (!terminalId) {
    res.status(400).json({ error: 'Informe o terminal.' });
    return;
  }
  const ok = await setDefaultPayTerminal(req.companyUuid!, environment, terminalId);
  if (!ok) {
    res.status(404).json({ error: 'Terminal não encontrado. Sincronize os terminais novamente.' });
    return;
  }
  res.json({ ok: true, defaultTerminalId: terminalId });
});

// ─────────────────────────── Pedidos ───────────────────────────

router.get('/orders', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const environment = req.query.all === '1'
    ? null
    : req.query.environment
      ? environmentFrom(req.query.environment)
      : await getCompanyPayEnvironment(req.companyUuid!);
  const limit = Number(req.query.limit ?? 25);
  const orders = await listPayOrders(req.companyUuid!, environment, Number.isFinite(limit) ? limit : 25);
  res.json({ orders: orders.map(serializePayOrder), environment });
});

const ORIGINS: PayOrderOrigin[] = ['pdv', 'painel', 'teste'];

router.post('/orders', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const environment = body.environment
    ? environmentFrom(body.environment)
    : await getCompanyPayEnvironment(req.companyUuid!);
  const account = await getPayAccount(req.companyUuid!, environment);
  if (!account) {
    res.status(401).json({ error: 'Conecte a conta Mercado Pago antes de cobrar na maquininha.' });
    return;
  }
  const amountCents = Math.round(Number(body.amountCents));
  if (!Number.isFinite(amountCents) || amountCents < 1) {
    res.status(400).json({ error: 'Informe o valor da cobrança.' });
    return;
  }
  const originRaw = String(body.origin ?? 'painel') as PayOrderOrigin;
  const origin: PayOrderOrigin = ORIGINS.includes(originRaw) ? originRaw : 'painel';
  try {
    const order = await createPayOrder({
      companyUuid: req.companyUuid!,
      environment,
      origin,
      amountCents,
      description: String(body.description ?? '').trim() || null,
      terminalId: body.terminalId ? String(body.terminalId) : null,
      saleUuid: body.saleUuid ? String(body.saleUuid).slice(0, 36) : null,
    });
    res.status(201).json({ order: serializePayOrder(order) });
  } catch (e) {
    fail(res, e);
  }
});

async function companyOrder(companyUuid: string, uuid: string) {
  return getPayOrderForCompany(companyUuid, uuid);
}

router.get('/orders/:uuid', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const uuid = String(req.params.uuid);
  const owner = await companyOrder(req.companyUuid!, uuid);
  if (!owner) {
    res.status(404).json({ error: 'Cobrança não encontrada.' });
    return;
  }
  try {
    const row = await refreshPayOrderIfStale(uuid);
    if (!row) {
      res.status(404).json({ error: 'Cobrança não encontrada.' });
      return;
    }
    res.json({ order: serializePayOrder(row) });
  } catch (e) {
    fail(res, e);
  }
});

router.post('/orders/:uuid/cancel', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const uuid = String(req.params.uuid);
  const owner = await companyOrder(req.companyUuid!, uuid);
  if (!owner) {
    res.status(404).json({ error: 'Cobrança não encontrada.' });
    return;
  }
  try {
    const row = await cancelPayOrder(uuid);
    res.json({ ok: true, order: row ? serializePayOrder(row) : null });
  } catch (e) {
    fail(res, e);
  }
});

router.post('/orders/:uuid/refund', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const uuid = String(req.params.uuid);
  const owner = await companyOrder(req.companyUuid!, uuid);
  if (!owner) {
    res.status(404).json({ error: 'Cobrança não encontrada.' });
    return;
  }
  try {
    const row = await refundPayOrder(uuid);
    res.json({ ok: true, order: row ? serializePayOrder(row) : null });
  } catch (e) {
    fail(res, e);
  }
});

router.post('/orders/:uuid/simulate', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const uuid = String(req.params.uuid);
  const owner = await companyOrder(req.companyUuid!, uuid);
  if (!owner) {
    res.status(404).json({ error: 'Cobrança não encontrada.' });
    return;
  }
  const raw = String((req.body ?? {}).status ?? 'processed');
  const allowed = ['processed', 'canceled', 'expired', 'refunded'] as const;
  type SimStatus = (typeof allowed)[number];
  const status: SimStatus = (allowed as readonly string[]).includes(raw) ? (raw as SimStatus) : 'processed';
  try {
    const row = await simulatePayOrderEvent(uuid, status);
    res.json({ ok: true, order: row ? serializePayOrder(row) : null });
  } catch (e) {
    fail(res, e);
  }
});

export default router;
