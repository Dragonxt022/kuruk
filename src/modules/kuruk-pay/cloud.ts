import { getLicenseCredentials } from '../../core/license/service';
import { getCloudServerUrl } from '../../core/config/cloud';
import { withLegacyBrandHeaders } from '../../core/http/brandHeaders';

/**
 * Cliente do Kuruk Pay no cloud.
 *
 * O app local nunca fala com o Mercado Pago: manda a cobrança para o cloud, que tem o
 * token OAuth da empresa. Toda função devolve um resultado (nunca lança) para a tela
 * conseguir mostrar "sem conexão com a nuvem" em vez de quebrar.
 */

export interface PayAccountInfo {
  environment: 'teste' | 'producao';
  userId: string | null;
  nickname: string | null;
  email: string | null;
  liveMode: boolean;
  status: string;
  lastError: string | null;
  connectedAt: string | null;
}

export interface PayTerminalInfo {
  terminalId: string;
  name: string | null;
  label: string;
  posId: string | null;
  storeId: string | null;
  operatingMode: string | null;
  isDefault: boolean;
  syncedAt?: string;
}

export interface PayAccountState {
  configured: boolean;
  connected: boolean;
  environment: 'teste' | 'producao';
  defaultEnvironment: 'teste' | 'producao';
  callbackUrl: string;
  environments: { environment: 'teste' | 'producao'; configured: boolean }[];
  account: PayAccountInfo | null;
  terminals: PayTerminalInfo[];
  defaultTerminalId: string | null;
}

export interface PayOrder {
  uuid: string;
  environment: 'teste' | 'producao';
  origin: 'pdv' | 'painel' | 'teste';
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

export type PayResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status: number };

function baseUrl(): string | null {
  const { companyUuid, licenseKey } = getLicenseCredentials();
  const url = getCloudServerUrl();
  if (!companyUuid || !licenseKey || !url) return null;
  return url.replace(/\/$/, '');
}

function headers(): Record<string, string> {
  const { companyUuid, licenseKey } = getLicenseCredentials();
  return withLegacyBrandHeaders({
    'Content-Type': 'application/json',
    'X-Kuruk-Company': companyUuid ?? '',
    'X-Kuruk-License-Key': licenseKey ?? '',
  });
}

async function payRequest<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
  timeoutMs = 12_000,
): Promise<PayResult<T>> {
  const base = baseUrl();
  if (!base) {
    return { ok: false, error: 'Este computador ainda não está conectado à nuvem do Kuruk.', status: 0 };
  }
  try {
    const res = await fetch(`${base}/api/pay${path}`, {
      method: init.method ?? 'GET',
      headers: headers(),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const msg = (json as { error?: string } | null)?.error;
      return { ok: false, error: msg || `A nuvem respondeu HTTP ${res.status}.`, status: res.status };
    }
    return { ok: true, data: json as T };
  } catch (e) {
    const msg = (e as Error).name === 'TimeoutError'
      ? 'A nuvem demorou para responder. Tente novamente.'
      : `Sem conexão com a nuvem: ${(e as Error).message}`;
    return { ok: false, error: msg, status: 0 };
  }
}

export async function fetchPayAccount(environment?: 'teste' | 'producao'): Promise<PayResult<PayAccountState>> {
  const qs = environment ? `?environment=${environment}` : '';
  return payRequest<PayAccountState>(`/account${qs}`, {}, 8_000);
}

/** Troca o ambiente da empresa com um clique (o PDV passa a usar o novo). */
export async function switchPayEnvironment(
  environment: 'teste' | 'producao',
): Promise<PayResult<{ ok: true; environment: 'teste' | 'producao' }>> {
  return payRequest('/environment', { method: 'POST', body: { environment } });
}

export async function connectPayAccount(
  environment: 'teste' | 'producao',
  returnUrl = '/pay/conectado?origem=desktop',
): Promise<PayResult<{ url: string }>> {
  return payRequest<{ url: string }>('/account/connect', {
    method: 'POST',
    body: { environment, returnUrl },
  });
}

export async function disconnectPayAccount(environment: 'teste' | 'producao'): Promise<PayResult<{ ok: true }>> {
  return payRequest<{ ok: true }>('/account/disconnect', { method: 'POST', body: { environment } });
}

export async function syncPayTerminals(
  environment?: 'teste' | 'producao',
): Promise<PayResult<{ ok: true; count: number; terminals: PayTerminalInfo[]; defaultTerminalId: string | null }>> {
  return payRequest('/terminals/sync', { method: 'POST', body: environment ? { environment } : {} }, 25_000);
}

export async function setDefaultPayTerminal(
  environment: 'teste' | 'producao',
  terminalId: string,
): Promise<PayResult<{ ok: true; defaultTerminalId: string }>> {
  return payRequest('/terminals/default', { method: 'POST', body: { environment, terminalId } });
}

export async function fetchPayOrders(
  environment?: 'teste' | 'producao',
  limit = 25,
): Promise<PayResult<{ orders: PayOrder[] }>> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (environment) params.set('environment', environment);
  return payRequest(`/orders?${params.toString()}`, {}, 10_000);
}

export interface CreatePointOrderInput {
  amountCents: number;
  description?: string | null;
  terminalId?: string | null;
  origin?: 'pdv' | 'painel' | 'teste';
  saleUuid?: string | null;
  environment?: 'teste' | 'producao';
}

export async function createPointOrder(
  input: CreatePointOrderInput,
): Promise<PayResult<{ order: PayOrder }>> {
  return payRequest('/orders', {
    method: 'POST',
    body: {
      amountCents: input.amountCents,
      description: input.description ?? null,
      terminalId: input.terminalId ?? null,
      origin: input.origin ?? 'pdv',
      saleUuid: input.saleUuid ?? null,
      environment: input.environment ?? null,
    },
  }, 30_000);
}

export async function getPointOrder(uuid: string): Promise<PayResult<{ order: PayOrder }>> {
  return payRequest(`/orders/${encodeURIComponent(uuid)}`, {}, 12_000);
}

export async function cancelPointOrder(uuid: string): Promise<PayResult<{ ok: true; order: PayOrder | null }>> {
  return payRequest(`/orders/${encodeURIComponent(uuid)}/cancel`, { method: 'POST', body: {} }, 20_000);
}

export async function refundPointOrder(uuid: string): Promise<PayResult<{ ok: true; order: PayOrder | null }>> {
  return payRequest(`/orders/${encodeURIComponent(uuid)}/refund`, { method: 'POST', body: {} }, 20_000);
}

export interface PointConfig {
  enabled: boolean;
  environment: 'teste' | 'producao';
  terminals: PayTerminalInfo[];
  defaultTerminalId: string | null;
}

/**
 * Configuração enxuta usada pelo PDV. Timeout curto: o PDV não pode ficar esperando a
 * nuvem para abrir; se a consulta falhar, a opção "maquininha" simplesmente não aparece.
 */
export async function fetchPointConfig(): Promise<PointConfig> {
  const r = await fetchPayAccount();
  if (!r.ok || !r.data.connected) {
    return { enabled: false, environment: 'producao', terminals: [], defaultTerminalId: null };
  }
  return {
    enabled: r.data.terminals.length > 0,
    environment: r.data.environment,
    terminals: r.data.terminals,
    defaultTerminalId: r.data.defaultTerminalId,
  };
}

/** Estorno best-effort quando uma venda com Point é cancelada. */
export function refundPointOrderInBackground(uuid: string): void {
  if (!uuid) return;
  void refundPointOrder(uuid).then((r) => {
    if (!r.ok) console.error('[kuruk-pay] falha ao estornar pedido', uuid, r.error);
  });
}
