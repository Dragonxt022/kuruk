import { randomUUID } from 'node:crypto';
import { getPool } from './db';

/**
 * Kuruk Pay — pagamentos presenciais com a conta Mercado Pago DO LOJISTA.
 *
 * É um produto separado do gateway de assinaturas (`gateway.ts`): ali o dinheiro é do
 * Kuruk; aqui o token é da empresa conectada e o pagamento cai direto na conta dela.
 *
 * Decisões que valem explicação:
 *
 *  1. **OAuth, não Access Token colado.** O lojista clica em "Conectar Mercado Pago",
 *     autoriza no site do MP e o Kuruk guarda access/refresh token. O token nunca volta
 *     para a tela: a view só sabe se existe e de quem é a conta.
 *  2. **O webhook não é fonte da verdade.** Ele só diz "olhe o pedido X"; o estado é
 *     relido em `GET /v1/orders/{id}` com o token da empresa. Notificação forjada não
 *     marca pedido como pago.
 *  3. **Tudo é por empresa + ambiente.** Teste e produção convivem; desconectar uma conta
 *     não apaga o histórico de pedidos.
 */

export const PAY_API_BASE = (process.env.MP_PAY_API_BASE ?? 'https://api.mercadopago.com').replace(/\/+$/, '');
export const PAY_AUTH_BASE = (process.env.MP_PAY_AUTH_BASE ?? 'https://auth.mercadopago.com.br').replace(/\/+$/, '');

/**
 * Terminal virtual padrão do Mercado Pago para TESTE do Point.
 *
 * O MP não processa pagamento real em maquininha física com conta de teste. Em vez
 * disso, oferece o dispositivo virtual de serial `SBX0000001`; o ID combina o
 * `poi_type` com esse serial. A lista `/terminals/v1/list` pode não devolvê-lo, então
 * ele é semeado sozinho quando a empresa usa o ambiente de teste.
 */
export const PAY_TEST_VIRTUAL_TERMINAL_ID = (
  process.env.MP_PAY_VIRTUAL_TERMINAL_ID ?? 'NEWLAND_N950__SBX0000001'
).trim();
export const PAY_TEST_VIRTUAL_TERMINAL_NAME = 'Terminal virtual (teste)';

const KEY_ENVIRONMENT = 'pay_environment';
const KEY_CLIENT_ID = 'pay_client_id';
const KEY_CLIENT_SECRET = 'pay_client_secret';
const KEY_WEBHOOK_SECRET = 'pay_webhook_secret';
/** Credenciais do APLICATIVO de teste, separadas das de produção. */
const KEY_TEST_CLIENT_ID = 'pay_client_id_teste';
const KEY_TEST_CLIENT_SECRET = 'pay_client_secret_teste';
const KEY_TEST_WEBHOOK_SECRET = 'pay_webhook_secret_teste';

export type PayEnvironment = 'teste' | 'producao';
export type PayOrderOrigin = 'pdv' | 'painel' | 'teste';

export function normalizePayEnvironment(value: unknown): PayEnvironment {
  return String(value ?? '').trim().toLowerCase() === 'teste' ? 'teste' : 'producao';
}

export class PayError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(message: string, status = 0, detail = '') {
    super(message);
    this.name = 'PayError';
    this.status = status;
    this.detail = detail;
  }
}

/** Mensagem que o lojista consegue entender, sem jargão de API. */
export function friendlyPayMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (/invalid_grant|invalid refresh token|refresh token/i.test(msg)) {
    return 'A autorização com o Mercado Pago expirou ou foi revogada. Clique em "Conectar Mercado Pago" novamente.';
  }
  if (/unauthorized|access token|401/i.test(msg)) {
    return 'O Mercado Pago recusou o acesso. Reconecte a conta em Kuruk Pay.';
  }
  if (/terminal|device/i.test(msg) && /not found|invalid/i.test(msg)) {
    return 'Terminal não encontrado na conta Mercado Pago. Sincronize os terminais e escolha um disponível.';
  }
  return msg;
}

// ─────────────────────────── Configuração do aplicativo ───────────────────────────

export interface PayAppSettings {
  environment: PayEnvironment;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
}

export interface PayEnvironmentSettingsView {
  environment: PayEnvironment;
  configured: boolean;
  clientId: string;
  clientSecretSet: boolean;
  webhookSecretSet: boolean;
}

export interface PayAppSettingsView {
  /** Configuração do ambiente PADRÃO (o que a tela antiga mostrava). */
  configured: boolean;
  defaultEnvironment: PayEnvironment;
  clientId: string;
  clientSecretSet: boolean;
  webhookSecretSet: boolean;
  callbackUrl: string;
  apiBase: string;
  environments: PayEnvironmentSettingsView[];
}

async function readAppSettings(): Promise<Record<string, string>> {
  const keys = [
    KEY_ENVIRONMENT,
    KEY_CLIENT_ID, KEY_CLIENT_SECRET, KEY_WEBHOOK_SECRET,
    KEY_TEST_CLIENT_ID, KEY_TEST_CLIENT_SECRET, KEY_TEST_WEBHOOK_SECRET,
  ];
  const [rows] = await getPool().query(
    `SELECT setting_key, setting_value FROM app_settings
      WHERE setting_key IN (${keys.map(() => '?').join(',')})`,
    keys,
  );
  const out: Record<string, string> = {};
  for (const r of rows as { setting_key: string; setting_value: string | null }[]) {
    out[r.setting_key] = r.setting_value ?? '';
  }
  return out;
}

/** Credenciais do aplicativo para UM ambiente. Teste e produção são independentes. */
export async function loadPayAppSettings(
  environment: PayEnvironment = 'producao',
): Promise<PayAppSettings> {
  const raw = await readAppSettings();
  const teste = environment === 'teste';
  if (teste) {
    return {
      environment,
      clientId: raw[KEY_TEST_CLIENT_ID] || (process.env.MP_PAY_CLIENT_ID_TESTE ?? '').trim(),
      clientSecret: raw[KEY_TEST_CLIENT_SECRET] || (process.env.MP_PAY_CLIENT_SECRET_TESTE ?? '').trim(),
      webhookSecret: raw[KEY_TEST_WEBHOOK_SECRET] || (process.env.MP_PAY_WEBHOOK_SECRET_TESTE ?? '').trim(),
    };
  }
  return {
    environment,
    clientId: raw[KEY_CLIENT_ID] || (process.env.MP_PAY_CLIENT_ID ?? '').trim(),
    clientSecret: raw[KEY_CLIENT_SECRET] || (process.env.MP_PAY_CLIENT_SECRET ?? '').trim(),
    webhookSecret: raw[KEY_WEBHOOK_SECRET] || (process.env.MP_PAY_WEBHOOK_SECRET ?? '').trim(),
  };
}

const PAY_ENVIRONMENTS: PayEnvironment[] = ['producao', 'teste'];

export async function loadPayAppSettingsView(): Promise<PayAppSettingsView> {
  const raw = await readAppSettings();
  const defaultEnvironment = normalizePayEnvironment(raw[KEY_ENVIRONMENT]);

  const environments = await Promise.all(PAY_ENVIRONMENTS.map(async (env): Promise<PayEnvironmentSettingsView> => {
    const s = await loadPayAppSettings(env);
    return {
      environment: env,
      configured: Boolean(s.clientId && s.clientSecret),
      clientId: s.clientId,
      clientSecretSet: Boolean(s.clientSecret),
      webhookSecretSet: Boolean(s.webhookSecret),
    };
  }));
  const active = environments.find((e) => e.environment === defaultEnvironment)!;

  return {
    configured: active.configured,
    defaultEnvironment,
    clientId: active.clientId,
    clientSecretSet: active.clientSecretSet,
    webhookSecretSet: active.webhookSecretSet,
    callbackUrl: payCallbackUrl(),
    apiBase: PAY_API_BASE,
    environments,
  };
}

/** Campo de segredo em branco MANTÉM o que já está salvo (mesma regra do SMTP/gateway). */
export async function savePayAppSettings(
  environment: PayEnvironment,
  body: Record<string, unknown>,
): Promise<void> {
  const upsert = (key: string, value: string | null) =>
    getPool().query(
      `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      [key, value],
    );
  const teste = environment === 'teste';
  const clientIdKey = teste ? KEY_TEST_CLIENT_ID : KEY_CLIENT_ID;
  const clientSecretKey = teste ? KEY_TEST_CLIENT_SECRET : KEY_CLIENT_SECRET;
  const webhookKey = teste ? KEY_TEST_WEBHOOK_SECRET : KEY_WEBHOOK_SECRET;

  const clientId = String(body.clientId ?? '').trim();
  if (clientId) await upsert(clientIdKey, clientId);
  const secret = String(body.clientSecret ?? '').trim();
  if (secret) await upsert(clientSecretKey, secret);
  const webhook = String(body.webhookSecret ?? '').trim();
  if (webhook) await upsert(webhookKey, webhook);
}

/** Troca o ambiente PADRÃO (empresas que ainda não escolheram o próprio). */
export async function setPayDefaultEnvironment(environment: PayEnvironment): Promise<boolean> {
  const s = await loadPayAppSettings(environment);
  if (!s.clientId || !s.clientSecret) return false;
  await getPool().query(
    `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [KEY_ENVIRONMENT, environment],
  );
  return true;
}

export async function getPayDefaultEnvironment(): Promise<PayEnvironment> {
  const raw = await readAppSettings();
  return normalizePayEnvironment(raw[KEY_ENVIRONMENT]);
}

/** Escolha explícita da empresa; se não houver, vale o padrão global. */
export async function getCompanyPayEnvironment(companyUuid: string): Promise<PayEnvironment> {
  const [rows] = await getPool().query(
    'SELECT active_environment FROM pay_company_settings WHERE company_uuid = ? LIMIT 1',
    [companyUuid],
  );
  const row = (rows as { active_environment: PayEnvironment }[])[0];
  if (row) return normalizePayEnvironment(row.active_environment);
  return getPayDefaultEnvironment();
}

export async function setCompanyPayEnvironment(
  companyUuid: string,
  environment: PayEnvironment,
): Promise<void> {
  await getPool().query(
    `INSERT INTO pay_company_settings (company_uuid, active_environment) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE active_environment = VALUES(active_environment)`,
    [companyUuid, environment],
  );
}

export async function payEnvironmentConfigured(environment: PayEnvironment): Promise<boolean> {
  const s = await loadPayAppSettings(environment);
  return Boolean(s.clientId && s.clientSecret);
}

export function payCallbackUrl(): string {
  const base = (process.env.CLOUD_PUBLIC_URL ?? 'https://kuruk.com.br').replace(/\/+$/, '');
  return (process.env.MP_PAY_REDIRECT_URL ?? `${base}/api/pay/oauth/callback`).trim();
}

function newState(): string {
  return randomUUID().replace(/-/g, '');
}

// ─────────────────────────── Conta conectada ───────────────────────────

export interface PayAccountRow {
  company_uuid: string;
  environment: PayEnvironment;
  mp_user_id: string | null;
  nickname: string | null;
  email: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | Date | null;
  scope: string | null;
  live_mode: number;
  status: 'conectado' | 'expirado' | 'erro';
  last_error: string | null;
  default_terminal_id: string | null;
  connected_at: string | Date | null;
  updated_at: string | Date | null;
}

export async function getPayAccount(
  companyUuid: string,
  environment: PayEnvironment,
): Promise<PayAccountRow | null> {
  const [rows] = await getPool().query(
    'SELECT * FROM pay_accounts WHERE company_uuid = ? AND environment = ? LIMIT 1',
    [companyUuid, environment],
  );
  return ((rows as PayAccountRow[])[0]) ?? null;
}

/** Conta ativa de uma empresa: prefere produção; teste só aparece se for a única. */
export async function getActivePayAccount(
  companyUuid: string,
  environment?: PayEnvironment,
): Promise<PayAccountRow | null> {
  const env = environment ?? await getCompanyPayEnvironment(companyUuid);
  return getPayAccount(companyUuid, env);
}

interface OAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  user_id?: string | number;
  scope?: string;
  live_mode?: boolean;
  error?: string;
  message?: string;
}

interface PayMe {
  id?: string | number;
  nickname?: string;
  email?: string;
}

export async function savePayAccount(
  companyUuid: string,
  environment: PayEnvironment,
  token: OAuthTokenResponse,
  me: PayMe | null,
): Promise<void> {
  if (!token.access_token) throw new PayError('O Mercado Pago não devolveu o token de acesso.');
  const expires = token.expires_in
    ? new Date(Date.now() + Number(token.expires_in) * 1000)
    : null;
  await getPool().query(
    `INSERT INTO pay_accounts
       (company_uuid, environment, mp_user_id, nickname, email, access_token, refresh_token,
        token_expires_at, scope, live_mode, status, last_error, connected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'conectado', NULL, NOW(3))
     ON DUPLICATE KEY UPDATE
       mp_user_id = VALUES(mp_user_id), nickname = VALUES(nickname), email = VALUES(email),
       access_token = VALUES(access_token), refresh_token = VALUES(refresh_token),
       token_expires_at = VALUES(token_expires_at), scope = VALUES(scope),
       live_mode = VALUES(live_mode), status = 'conectado', last_error = NULL,
       connected_at = NOW(3)`,
    [
      companyUuid,
      environment,
      me?.id != null ? String(me.id) : (token.user_id != null ? String(token.user_id) : null),
      me?.nickname ?? null,
      me?.email ?? null,
      token.access_token,
      token.refresh_token ?? null,
      expires,
      token.scope ?? null,
      token.live_mode ? 1 : 0,
    ],
  );
}

export async function disconnectPayAccount(
  companyUuid: string,
  environment: PayEnvironment,
): Promise<boolean> {
  const [r] = await getPool().query(
    'DELETE FROM pay_accounts WHERE company_uuid = ? AND environment = ?',
    [companyUuid, environment],
  );
  return Boolean((r as { affectedRows: number }).affectedRows);
}

async function markAccountError(companyUuid: string, environment: PayEnvironment, message: string): Promise<void> {
  try {
    await getPool().query(
      `UPDATE pay_accounts SET status = 'erro', last_error = ?
        WHERE company_uuid = ? AND environment = ?`,
      [message.slice(0, 500), companyUuid, environment],
    );
  } catch {
    // registro é informativo: não pode esconder o erro original
  }
}

// ─────────────────────────── OAuth ───────────────────────────

export interface PayOAuthStateRow {
  state: string;
  company_uuid: string;
  environment: PayEnvironment;
  return_url: string | null;
  created_at: string | Date;
  expires_at: string | Date;
}

export async function createPayOAuthState(
  companyUuid: string,
  environment: PayEnvironment,
  returnUrl: string | null,
): Promise<string> {
  const state = newState();
  await getPool().query('DELETE FROM pay_oauth_states WHERE expires_at < NOW(3)');
  await getPool().query(
    `INSERT INTO pay_oauth_states (state, company_uuid, environment, return_url, expires_at)
     VALUES (?, ?, ?, ?, DATE_ADD(NOW(3), INTERVAL 15 MINUTE))`,
    [state, companyUuid, environment, returnUrl],
  );
  return state;
}

export async function consumePayOAuthState(state: string): Promise<PayOAuthStateRow | null> {
  if (!state) return null;
  const [rows] = await getPool().query(
    'SELECT * FROM pay_oauth_states WHERE state = ? LIMIT 1',
    [state],
  );
  const row = (rows as PayOAuthStateRow[])[0];
  await getPool().query('DELETE FROM pay_oauth_states WHERE state = ?', [state]);
  if (!row) return null;
  const expires = new Date(row.expires_at as string).getTime();
  if (!Number.isFinite(expires) || expires < Date.now()) return null;
  return row;
}

export function buildPayAuthUrl(state: string, clientId: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    platform_id: 'mp',
    state,
    redirect_uri: payCallbackUrl(),
  });
  return `${PAY_AUTH_BASE}/authorization?${params.toString()}`;
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function tokenErrorMessage(json: Record<string, unknown> | null, status: number): string {
  const err = String(json?.error ?? '');
  const msg = String(json?.message ?? json?.error_description ?? '');
  return `Mercado Pago recusou a autorização (HTTP ${status})${err ? `: ${err}` : ''}${msg ? ` — ${msg}` : ''}`;
}

export async function exchangePayCode(
  code: string,
  environment: PayEnvironment,
): Promise<OAuthTokenResponse> {
  const app = await loadPayAppSettings(environment);
  if (!app.clientId || !app.clientSecret) {
    throw new PayError(`O aplicativo Kuruk Pay não está configurado no ambiente de ${environment === 'teste' ? 'teste' : 'produção'}.`);
  }
  const res = await fetch(`${PAY_API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: payCallbackUrl(),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = await readJson(res);
  if (!res.ok || !json?.access_token) throw new PayError(tokenErrorMessage(json, res.status), res.status);
  return json as OAuthTokenResponse;
}

export async function fetchPayMe(accessToken: string): Promise<PayMe | null> {
  try {
    const res = await fetch(`${PAY_API_BASE}/users/me`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return (await readJson(res)) as PayMe | null;
  } catch {
    return null;
  }
}

async function refreshPayToken(row: PayAccountRow): Promise<string> {
  const app = await loadPayAppSettings(row.environment);
  if (!row.refresh_token) throw new PayError('A conexão com o Mercado Pago expirou. Conecte novamente.');
  if (!app.clientId || !app.clientSecret) throw new PayError('O aplicativo Kuruk Pay não está configurado neste ambiente.');
  const res = await fetch(`${PAY_API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: row.refresh_token,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = await readJson(res);
  if (!res.ok || !json?.access_token) {
    await markAccountError(row.company_uuid, row.environment, tokenErrorMessage(json, res.status));
    throw new PayError(tokenErrorMessage(json, res.status), res.status);
  }
  const token = json as OAuthTokenResponse;
  const expires = token.expires_in ? new Date(Date.now() + Number(token.expires_in) * 1000) : null;
  await getPool().query(
    `UPDATE pay_accounts
        SET access_token = ?, refresh_token = COALESCE(?, refresh_token),
            token_expires_at = ?, status = 'conectado', last_error = NULL
      WHERE company_uuid = ? AND environment = ?`,
    [token.access_token, token.refresh_token ?? null, expires, row.company_uuid, row.environment],
  );
  return token.access_token!;
}

async function accessTokenFor(row: PayAccountRow): Promise<string> {
  if (!row.access_token) throw new PayError('Conecte a conta Mercado Pago para usar a maquininha.', 401);
  const expires = row.token_expires_at ? new Date(row.token_expires_at).getTime() : 0;
  if (row.refresh_token && expires && expires - Date.now() < 5 * 60_000) {
    return refreshPayToken(row);
  }
  return row.access_token;
}

async function mpPayFetch(
  path: string,
  init: { method?: string; body?: unknown; token: string; headers?: Record<string, string>; timeoutMs?: number },
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${PAY_API_BASE}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${init.token}`,
        Accept: 'application/json',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(init.body !== undefined ? { 'X-Idempotency-Key': randomUUID() } : {}),
        ...(init.headers ?? {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
    });
  } catch (e) {
    throw new PayError(`Não foi possível falar com o Mercado Pago: ${(e as Error).message}`);
  }
  const json = await readJson(res);
  if (!res.ok) {
    const err = (json ?? {}) as { message?: string; error?: string; cause?: { description?: string }[] };
    const cause = Array.isArray(err.cause) && err.cause.length
      ? ` (${err.cause.map((c) => c.description).filter(Boolean).join('; ')})`
      : '';
    throw new PayError(
      `Mercado Pago recusou a operação (HTTP ${res.status}): ${err.message ?? err.error ?? 'sem detalhe'}${cause}`,
      res.status,
    );
  }
  return json;
}

/** Chamada autenticada com o token da empresa; renova uma vez se o MP devolver 401. */
async function payApiForAccount<T>(
  account: PayAccountRow,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  try {
    const token = await accessTokenFor(account);
    return (await mpPayFetch(path, { ...init, token })) as T;
  } catch (e) {
    if (e instanceof PayError && e.status === 401 && account.refresh_token) {
      const token = await refreshPayToken(account);
      return (await mpPayFetch(path, { ...init, token })) as T;
    }
    throw e;
  }
}

export async function payApiForCompany<T>(
  companyUuid: string,
  environment: PayEnvironment,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const account = await getPayAccount(companyUuid, environment);
  if (!account) throw new PayError('Conecte a conta Mercado Pago para usar a maquininha.', 401);
  return payApiForAccount<T>(account, path, init);
}

// ─────────────────────────── Terminais ───────────────────────────

export interface PayTerminal {
  terminalId: string;
  name: string | null;
  posId: string | null;
  storeId: string | null;
  externalPosId: string | null;
  operatingMode: string | null;
  raw?: unknown;
}

interface RawTerminal {
  id?: string | number;
  terminal_id?: string | number;
  name?: string;
  pos_id?: string | number;
  store_id?: string | number;
  external_pos_id?: string | number;
  operating_mode?: string;
}

export function parseTerminal(raw: RawTerminal): PayTerminal | null {
  const id = raw.id ?? raw.terminal_id;
  if (id == null || String(id).trim() === '') return null;
  return {
    terminalId: String(id),
    name: raw.name ? String(raw.name) : null,
    posId: raw.pos_id != null ? String(raw.pos_id) : null,
    storeId: raw.store_id != null ? String(raw.store_id) : null,
    externalPosId: raw.external_pos_id != null ? String(raw.external_pos_id) : null,
    operatingMode: raw.operating_mode ? String(raw.operating_mode) : null,
    raw,
  };
}

export async function listPayTerminalsFromMp(
  companyUuid: string,
  environment: PayEnvironment,
): Promise<PayTerminal[]> {
  const payload = await payApiForCompany<Record<string, unknown>>(
    companyUuid,
    environment,
    '/terminals/v1/list?limit=50',
  );
  const data = (payload.data ?? payload) as Record<string, unknown>;
  const list = (data.terminals ?? payload.terminals ?? []) as RawTerminal[];
  if (!Array.isArray(list)) return [];
  return list.map(parseTerminal).filter((t): t is PayTerminal => Boolean(t));
}

export async function syncPayTerminals(
  companyUuid: string,
  environment: PayEnvironment,
): Promise<PayTerminal[]> {
  const terminals = await listPayTerminalsFromMp(companyUuid, environment);
  // No teste, o dispositivo virtual é o único jeito de concluir uma cobrança sem
  // maquininha física. Ele entra mesmo que a lista do MP venha vazia.
  if (environment === 'teste'
    && !terminals.some((t) => t.terminalId === PAY_TEST_VIRTUAL_TERMINAL_ID)) {
    terminals.push({
      terminalId: PAY_TEST_VIRTUAL_TERMINAL_ID,
      name: PAY_TEST_VIRTUAL_TERMINAL_NAME,
      posId: null,
      storeId: null,
      externalPosId: null,
      operatingMode: 'PDV',
      raw: { virtual: true, serial: 'SBX0000001' },
    });
  }
  const ids = terminals.map((t) => t.terminalId);
  if (terminals.length) {
    for (const t of terminals) {
      await getPool().query(
        `INSERT INTO pay_terminals
           (company_uuid, environment, terminal_id, name, pos_id, store_id, external_pos_id,
            operating_mode, raw_json, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3))
         ON DUPLICATE KEY UPDATE
           name = VALUES(name), pos_id = VALUES(pos_id), store_id = VALUES(store_id),
           external_pos_id = VALUES(external_pos_id), operating_mode = VALUES(operating_mode),
           raw_json = VALUES(raw_json), synced_at = NOW(3)`,
        [
          companyUuid, environment, t.terminalId, t.name, t.posId, t.storeId,
          t.externalPosId, t.operatingMode, JSON.stringify(t.raw ?? null),
        ],
      );
    }
    await getPool().query(
      `DELETE FROM pay_terminals
        WHERE company_uuid = ? AND environment = ?
          AND terminal_id NOT IN (${ids.map(() => '?').join(',')})`,
      [companyUuid, environment, ...ids],
    );
  } else {
    await getPool().query(
      'DELETE FROM pay_terminals WHERE company_uuid = ? AND environment = ?',
      [companyUuid, environment],
    );
  }

  const account = await getPayAccount(companyUuid, environment);
  if (account?.default_terminal_id && !ids.includes(account.default_terminal_id)) {
    await getPool().query(
      'UPDATE pay_accounts SET default_terminal_id = NULL WHERE company_uuid = ? AND environment = ?',
      [companyUuid, environment],
    );
  }
  return terminals;
}

export interface PayTerminalRow {
  company_uuid: string;
  environment: PayEnvironment;
  terminal_id: string;
  name: string | null;
  pos_id: string | null;
  store_id: string | null;
  external_pos_id: string | null;
  operating_mode: string | null;
  synced_at: string | Date;
}

export async function getPayTerminals(
  companyUuid: string,
  environment: PayEnvironment,
): Promise<PayTerminalRow[]> {
  const [rows] = await getPool().query(
    `SELECT company_uuid, environment, terminal_id, name, pos_id, store_id, external_pos_id,
            operating_mode, synced_at
       FROM pay_terminals WHERE company_uuid = ? AND environment = ?
      ORDER BY name IS NULL, name, terminal_id`,
    [companyUuid, environment],
  );
  return rows as PayTerminalRow[];
}

export async function setDefaultPayTerminal(
  companyUuid: string,
  environment: PayEnvironment,
  terminalId: string,
): Promise<boolean> {
  const [rows] = await getPool().query(
    'SELECT terminal_id FROM pay_terminals WHERE company_uuid = ? AND environment = ? AND terminal_id = ?',
    [companyUuid, environment, terminalId],
  );
  if (!(rows as unknown[]).length) return false;
  await getPool().query(
    'UPDATE pay_accounts SET default_terminal_id = ? WHERE company_uuid = ? AND environment = ?',
    [terminalId, companyUuid, environment],
  );
  return true;
}

// ─────────────────────────── Ordens (Point) ───────────────────────────

export interface PayOrderRow {
  id: number;
  uuid: string;
  company_uuid: string;
  environment: PayEnvironment;
  origin: PayOrderOrigin;
  external_reference: string;
  terminal_id: string | null;
  amount_cents: number;
  description: string | null;
  status: string;
  status_detail: string | null;
  mp_order_id: string | null;
  mp_payment_id: string | null;
  payment_type: string | null;
  payment_method_id: string | null;
  installments: number | null;
  refunded_amount_cents: number | null;
  sale_uuid: string | null;
  error: string | null;
  raw_json: unknown;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface PayOrderSnapshot {
  mpOrderId: string;
  status: string;
  statusDetail: string | null;
  amountCents: number | null;
  paidAmountCents: number | null;
  paymentId: string | null;
  paymentType: string | null;
  paymentMethodId: string | null;
  installments: number | null;
  refundedAmountCents: number | null;
  raw: unknown;
}

export interface PayOrderView {
  uuid: string;
  environment: PayEnvironment;
  origin: PayOrderOrigin;
  externalReference: string;
  terminalId: string | null;
  amountCents: number;
  description: string | null;
  status: string;
  statusDetail: string | null;
  paid: boolean;
  mpOrderId: string | null;
  paymentId: string | null;
  paymentType: string | null;
  paymentMethodId: string | null;
  cardBrand: string | null;
  installments: number | null;
  refundedAmountCents: number | null;
  saleUuid: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

function centsFrom(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

interface RawOrder {
  id?: string | number;
  status?: string;
  status_detail?: string;
  total_amount?: string | number;
  total_paid_amount?: string | number;
  transactions?: {
    payments?: {
      id?: string | number;
      status?: string;
      status_detail?: string;
      paid_amount?: string | number;
      refunded_amount?: string | number;
      payment_method?: { id?: string; type?: string; installments?: number };
      reference?: { id?: string | number };
    }[];
  };
}

export function parseOrder(raw: unknown): PayOrderSnapshot {
  const outer = (raw ?? {}) as Record<string, unknown>;
  const r = ((outer.data ?? outer) as RawOrder);
  const payments = r.transactions?.payments ?? [];
  const p = payments[0] ?? {};
  const method = p.payment_method ?? {};
  return {
    mpOrderId: String(r.id ?? ''),
    status: String(r.status ?? 'created'),
    statusDetail: r.status_detail ?? p.status_detail ?? null,
    amountCents: centsFrom(r.total_amount),
    paidAmountCents: centsFrom(r.total_paid_amount ?? p.paid_amount),
    paymentId: p.id != null ? String(p.id) : (p.reference?.id != null ? String(p.reference.id) : null),
    paymentType: method.type ?? null,
    paymentMethodId: method.id ?? null,
    installments: typeof method.installments === 'number' ? method.installments : null,
    refundedAmountCents: centsFrom(p.refunded_amount),
    raw: r,
  };
}

/** `processed` + `accredited` é o par que o Mercado Pago usa para "pago". */
export function payOrderIsPaid(status: string, detail: string | null): boolean {
  if (status === 'processed' || status === 'approved') {
    return !detail || detail === 'accredited' || detail === 'processed';
  }
  return false;
}

function orderIsFinal(status: string): boolean {
  return ['processed', 'approved', 'canceled', 'cancelled', 'expired', 'failed', 'rejected', 'refunded']
    .includes(status);
}

async function getPayOrderRow(uuid: string): Promise<PayOrderRow | null> {
  const [rows] = await getPool().query('SELECT * FROM pay_orders WHERE uuid = ? LIMIT 1', [uuid]);
  return ((rows as PayOrderRow[])[0]) ?? null;
}

async function updateOrderFromSnapshot(
  uuid: string,
  snapshot: PayOrderSnapshot,
  extra: { error?: string | null } = {},
): Promise<void> {
  await getPool().query(
    `UPDATE pay_orders
        SET status = ?, status_detail = ?, mp_order_id = COALESCE(NULLIF(?, ''), mp_order_id),
            mp_payment_id = COALESCE(?, mp_payment_id),
            payment_type = COALESCE(?, payment_type),
            payment_method_id = COALESCE(?, payment_method_id),
            installments = COALESCE(?, installments),
            refunded_amount_cents = COALESCE(?, refunded_amount_cents),
            error = ?, raw_json = ?
      WHERE uuid = ?`,
    [
      snapshot.status,
      snapshot.statusDetail,
      snapshot.mpOrderId,
      snapshot.paymentId,
      snapshot.paymentType,
      snapshot.paymentMethodId,
      snapshot.installments,
      snapshot.refundedAmountCents,
      extra.error ?? null,
      JSON.stringify(snapshot.raw ?? null),
      uuid,
    ],
  );
}

export interface CreatePayOrderInput {
  companyUuid: string;
  environment: PayEnvironment;
  origin: PayOrderOrigin;
  amountCents: number;
  description: string | null;
  terminalId?: string | null;
  saleUuid?: string | null;
}

export async function createPayOrder(input: CreatePayOrderInput): Promise<PayOrderRow> {
  const account = await getPayAccount(input.companyUuid, input.environment);
  if (!account?.access_token) {
    throw new PayError('Conecte a conta Mercado Pago antes de cobrar na maquininha.', 401);
  }
  const amount = Math.round(input.amountCents);
  if (!Number.isFinite(amount) || amount < 1) throw new PayError('Valor da cobrança inválido.');
  if (amount > 100_000_00) throw new PayError('Valor acima do limite permitido para uma cobrança.');

  const terminalId = String(input.terminalId ?? '').trim() || account.default_terminal_id || '';
  if (!terminalId) throw new PayError('Escolha o terminal Point que vai receber a cobrança.');
  const [termRows] = await getPool().query(
    'SELECT terminal_id FROM pay_terminals WHERE company_uuid = ? AND environment = ? AND terminal_id = ?',
    [input.companyUuid, input.environment, terminalId],
  );
  if (!(termRows as unknown[]).length) {
    throw new PayError('Terminal não encontrado. Sincronize os terminais e escolha um disponível.');
  }

  const uuid = randomUUID();
  const externalReference = `pay:${uuid}`;
  await getPool().query(
    `INSERT INTO pay_orders
       (uuid, company_uuid, environment, origin, external_reference, terminal_id,
        amount_cents, description, status, sale_uuid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?)`,
    [
      uuid, input.companyUuid, input.environment, input.origin, externalReference,
      terminalId, amount, input.description?.slice(0, 255) ?? null, input.saleUuid ?? null,
    ],
  );

  try {
    const raw = await payApiForAccount<unknown>(account, '/v1/orders', {
      method: 'POST',
      body: {
        type: 'point',
        external_reference: externalReference,
        description: (input.description || 'Venda Kuruk').slice(0, 120),
        transactions: { payments: [{ amount: (amount / 100).toFixed(2) }] },
        config: { point: { terminal_id: terminalId, print_on_terminal: 'no_ticket' } },
      },
    });
    const snapshot = parseOrder(raw);
    await updateOrderFromSnapshot(uuid, snapshot);
    return (await getPayOrderRow(uuid))!;
  } catch (e) {
    const msg = friendlyPayMessage(e);
    await getPool().query(
      `UPDATE pay_orders SET status = 'failed', error = ? WHERE uuid = ?`,
      [msg.slice(0, 500), uuid],
    );
    throw new PayError(msg, e instanceof PayError ? e.status : 0);
  }
}

export async function refreshPayOrder(uuid: string): Promise<PayOrderRow | null> {
  const row = await getPayOrderRow(uuid);
  if (!row) return null;
  if (!row.mp_order_id) return row;
  try {
    const raw = await payApiForCompany<unknown>(row.company_uuid, row.environment, `/v1/orders/${encodeURIComponent(row.mp_order_id)}`);
    const snapshot = parseOrder(raw);
    await updateOrderFromSnapshot(uuid, snapshot);
    return await getPayOrderRow(uuid);
  } catch (e) {
    if (e instanceof PayError && e.status === 404) return row;
    throw e;
  }
}

export async function getPayOrderForCompany(
  companyUuid: string,
  uuid: string,
): Promise<PayOrderRow | null> {
  const [rows] = await getPool().query(
    'SELECT * FROM pay_orders WHERE uuid = ? AND company_uuid = ? LIMIT 1',
    [uuid, companyUuid],
  );
  return ((rows as PayOrderRow[])[0]) ?? null;
}

/** Releitura no máximo a cada N ms — evita martelar a API em polling duplicado. */
export async function refreshPayOrderIfStale(uuid: string, maxAgeMs = 2500): Promise<PayOrderRow | null> {
  const row = await getPayOrderRow(uuid);
  if (!row) return null;
  const updated = new Date(row.updated_at as string).getTime();
  if (!Number.isFinite(updated) || Date.now() - updated < maxAgeMs) return row;
  // Pedido já finalizado não muda mais: não há motivo para consultar o MP de novo.
  if (orderIsFinal(row.status) && Date.now() - updated < 5 * 60_000) return row;
  return refreshPayOrder(uuid);
}

export async function cancelPayOrder(uuid: string): Promise<PayOrderRow | null> {
  const row = await getPayOrderRow(uuid);
  if (!row) return null;
  if (!row.mp_order_id) {
    await getPool().query(
      `UPDATE pay_orders SET status = 'canceled', status_detail = 'canceled_before_terminal' WHERE uuid = ?`,
      [uuid],
    );
    return getPayOrderRow(uuid);
  }
  await payApiForCompany<unknown>(
    row.company_uuid, row.environment,
    `/v1/orders/${encodeURIComponent(row.mp_order_id)}/cancel`,
    { method: 'POST', body: {}, headers: { 'x-allow-cancelable-status': 'at_terminal' } },
  );
  // A resposta do cancelamento varia (order ou recibo); o estado confiável é uma
  // releitura do pedido, como em todo o resto do módulo.
  try {
    return await refreshPayOrder(uuid);
  } catch {
    await getPool().query(
      `UPDATE pay_orders SET status = 'canceled', status_detail = 'canceled_by_api' WHERE uuid = ?`,
      [uuid],
    );
    return getPayOrderRow(uuid);
  }
}

export async function refundPayOrder(uuid: string): Promise<PayOrderRow | null> {
  const row = await getPayOrderRow(uuid);
  if (!row) return null;
  if (!row.mp_order_id) throw new PayError('Esta cobrança ainda não chegou ao Mercado Pago.');
  await payApiForCompany<unknown>(
    row.company_uuid, row.environment,
    `/v1/orders/${encodeURIComponent(row.mp_order_id)}/refund`,
    { method: 'POST', body: {} },
  );
  try {
    return await refreshPayOrder(uuid);
  } catch {
    await getPool().query(
      `UPDATE pay_orders
          SET status = 'refunded', refunded_amount_cents = COALESCE(refunded_amount_cents, amount_cents)
        WHERE uuid = ?`,
      [uuid],
    );
    return getPayOrderRow(uuid);
  }
}

/**
 * Simula o resultado de uma order no ambiente de TESTE.
 *
 * O Mercado Pago expõe `POST /v1/orders/{id}/events` para o dispositivo virtual. Sem
 * isso, uma cobrança de teste ficaria eternamente em `at_terminal` (não existe cartão
 * físico para passar). Nunca é permitido em produção.
 */
export async function simulatePayOrderEvent(
  uuid: string,
  event: 'processed' | 'canceled' | 'expired' | 'refunded',
): Promise<PayOrderRow | null> {
  const row = await getPayOrderRow(uuid);
  if (!row) return null;
  if (row.environment !== 'teste') {
    throw new PayError('A simulação de pagamento só existe no ambiente de teste.');
  }
  if (!row.mp_order_id) throw new PayError('A cobrança ainda não chegou ao Mercado Pago.');
  const body = event === 'processed'
    ? {
      status: 'processed',
      status_detail: 'accredited',
      payment_method_type: 'credit_card',
      payment_method_id: 'visa',
      installments: 1,
    }
    : { status: event };
  await payApiForCompany(
    row.company_uuid,
    row.environment,
    `/v1/orders/${encodeURIComponent(row.mp_order_id)}/events`,
    { method: 'POST', body },
  );
  // O MP pode levar alguns segundos para refletir; a tela continua no polling.
  try {
    return await refreshPayOrder(uuid);
  } catch {
    return getPayOrderRow(uuid);
  }
}

export function serializePayOrder(row: PayOrderRow): PayOrderView {
  return {
    uuid: row.uuid,
    environment: row.environment,
    origin: row.origin,
    externalReference: row.external_reference,
    terminalId: row.terminal_id,
    amountCents: Number(row.amount_cents),
    description: row.description,
    status: row.status,
    statusDetail: row.status_detail,
    paid: payOrderIsPaid(row.status, row.status_detail),
    mpOrderId: row.mp_order_id,
    paymentId: row.mp_payment_id,
    paymentType: row.payment_type,
    paymentMethodId: row.payment_method_id,
    cardBrand: row.payment_method_id,
    installments: row.installments,
    refundedAmountCents: row.refunded_amount_cents,
    saleUuid: row.sale_uuid,
    error: row.error,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

export async function listPayOrders(
  companyUuid: string,
  environment: PayEnvironment | null = null,
  limit = 25,
): Promise<PayOrderRow[]> {
  const capped = Math.min(Math.max(1, Math.round(limit)), 100);
  if (environment) {
    const [rows] = await getPool().query(
      'SELECT * FROM pay_orders WHERE company_uuid = ? AND environment = ? ORDER BY id DESC LIMIT ?',
      [companyUuid, environment, capped],
    );
    return rows as PayOrderRow[];
  }
  const [rows] = await getPool().query(
    'SELECT * FROM pay_orders WHERE company_uuid = ? ORDER BY id DESC LIMIT ?',
    [companyUuid, capped],
  );
  return rows as PayOrderRow[];
}

/**
 * Webhook de `order`: descobre de quem é o pedido pela nossa tabela (não confia no
 * user_id da notificação) e relê o estado com o token da empresa.
 */
export async function handlePayOrderNotification(
  mpOrderId: string,
  externalReference?: string | null,
): Promise<boolean> {
  if (!mpOrderId) return false;
  let [rows] = await getPool().query(
    'SELECT uuid, company_uuid, environment FROM pay_orders WHERE mp_order_id = ? LIMIT 1',
    [mpOrderId],
  );
  if (!(rows as unknown[]).length && externalReference) {
    [rows] = await getPool().query(
      'SELECT uuid, company_uuid, environment FROM pay_orders WHERE external_reference = ? LIMIT 1',
      [externalReference],
    );
    const found = (rows as { uuid: string }[])[0];
    if (found) {
      await getPool().query('UPDATE pay_orders SET mp_order_id = ? WHERE uuid = ?', [mpOrderId, found.uuid]);
    }
  }
  const row = (rows as { uuid: string }[])[0];
  if (!row) return false;
  await refreshPayOrder(row.uuid);
  return true;
}

// ─────────────────────────── Admin ───────────────────────────

export interface PayAccountAdminRow extends PayAccountRow {
  company_name: string | null;
  active_environment: PayEnvironment | null;
  orders_count: number;
  last_order_at: string | Date | null;
}

export async function listPayAccountsForAdmin(): Promise<PayAccountAdminRow[]> {
  const [rows] = await getPool().query(
    `SELECT a.*, c.name AS company_name, cs.active_environment AS active_environment,
            (SELECT COUNT(*) FROM pay_orders o WHERE o.company_uuid = a.company_uuid
               AND o.environment = a.environment) AS orders_count,
            (SELECT MAX(o.created_at) FROM pay_orders o WHERE o.company_uuid = a.company_uuid
               AND o.environment = a.environment) AS last_order_at
       FROM pay_accounts a
       LEFT JOIN companies c ON c.company_uuid = a.company_uuid
       LEFT JOIN pay_company_settings cs ON cs.company_uuid = a.company_uuid
      ORDER BY a.connected_at DESC, a.company_uuid`,
  );
  return rows as PayAccountAdminRow[];
}

export interface PayOrderAdminRow extends PayOrderRow {
  company_name: string | null;
}

export async function listPayOrdersForAdmin(limit = 40): Promise<PayOrderAdminRow[]> {
  const capped = Math.min(Math.max(1, Math.round(limit)), 200);
  const [rows] = await getPool().query(
    `SELECT o.*, c.name AS company_name
       FROM pay_orders o
       LEFT JOIN companies c ON c.company_uuid = o.company_uuid
      ORDER BY o.id DESC LIMIT ?`,
    [capped],
  );
  return rows as PayOrderAdminRow[];
}
