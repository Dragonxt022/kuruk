import { Router, type NextFunction, type Request, type Response } from 'express';
import { requirePermission } from '../../core/permissions/middleware';
import {
  cancelPointOrder, connectPayAccount, createPointOrder, disconnectPayAccount,
  fetchPayAccount, fetchPayOrders, fetchPointConfig, getPointOrder, refundPointOrder,
  setDefaultPayTerminal, simulatePointOrder, switchPayEnvironment, syncPayTerminals,
  type PayResult,
} from './cloud';

/**
 * Rotas do Kuruk Pay no app local.
 *
 * Os operadores do PDV usam `store.sales.create` para cobrar na maquininha (é a mesma
 * permissão de vender); gerenciar a conta/terminais exige `kurukpay.settings.manage`.
 */
const router = Router();

function canCharge(req: Request): boolean {
  return req.user?.permissions.has('kurukpay.orders.charge') === true
    || req.user?.permissions.has('store.sales.create') === true;
}

function requireCharge(req: Request, res: Response, next: NextFunction): void {
  if (canCharge(req)) {
    next();
    return;
  }
  res.status(403).json({ error: 'Sem permissão para cobrar na maquininha.' });
}

function send<T>(res: Response, result: PayResult<T>): void {
  if (result.ok) {
    res.json(result.data);
    return;
  }
  const status = result.status >= 400 && result.status < 600 ? result.status : 502;
  res.status(status).json({ error: result.error });
}

router.get('/account', requirePermission('kurukpay.settings.view'), async (req, res) => {
  const env = req.query.environment === 'teste' ? 'teste' : req.query.environment === 'producao' ? 'producao' : undefined;
  send(res, await fetchPayAccount(env));
});

/**
 * Configuração enxuta que o PDV consome. Fica aqui (e não em `/account`) porque o
 * operador de caixa não tem `kurukpay.settings.view`; ele só precisa saber se existe
 * terminal para oferecer "Cobrar na maquininha".
 */
router.get('/point-config', requireCharge, async (_req, res) => {
  res.json(await fetchPointConfig());
});

router.post('/account/connect', requirePermission('kurukpay.settings.manage'), async (req, res) => {
  const environment = (req.body ?? {}).environment === 'teste' ? 'teste' : 'producao';
  send(res, await connectPayAccount(environment));
});

/** Troca o ambiente da empresa (teste <-> produção) com um clique. */
router.post('/environment', requirePermission('kurukpay.settings.manage'), async (req, res) => {
  const environment = (req.body ?? {}).environment === 'teste' ? 'teste' : 'producao';
  send(res, await switchPayEnvironment(environment));
});

router.post('/account/disconnect', requirePermission('kurukpay.settings.manage'), async (req, res) => {
  const environment = (req.body ?? {}).environment === 'teste' ? 'teste' : 'producao';
  send(res, await disconnectPayAccount(environment));
});

router.post('/terminals/sync', requirePermission('kurukpay.settings.manage'), async (req, res) => {
  const env = (req.body ?? {}).environment;
  const environment = env === 'teste' || env === 'producao' ? env : undefined;
  send(res, await syncPayTerminals(environment));
});

router.post('/terminals/default', requirePermission('kurukpay.settings.manage'), async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const environment = body.environment === 'teste' ? 'teste' : 'producao';
  const terminalId = String(body.terminalId ?? '').trim();
  if (!terminalId) {
    res.status(400).json({ error: 'Informe o terminal.' });
    return;
  }
  send(res, await setDefaultPayTerminal(environment, terminalId));
});

router.get('/orders', requirePermission('kurukpay.orders.view'), async (req, res) => {
  const env = req.query.environment === 'teste' ? 'teste' : req.query.environment === 'producao' ? 'producao' : undefined;
  const limit = Number(req.query.limit ?? 25);
  send(res, await fetchPayOrders(env, Number.isFinite(limit) ? limit : 25));
});

router.post('/orders', requireCharge, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const amountCents = Math.round(Number(body.amountCents));
  if (!Number.isFinite(amountCents) || amountCents < 1) {
    res.status(400).json({ error: 'Informe o valor da cobrança.' });
    return;
  }
  const origin = body.origin === 'teste' ? 'teste' : body.origin === 'painel' ? 'painel' : 'pdv';
  send(res, await createPointOrder({
    amountCents,
    description: String(body.description ?? '').trim() || null,
    terminalId: body.terminalId ? String(body.terminalId) : null,
    origin,
    saleUuid: body.saleUuid ? String(body.saleUuid).slice(0, 36) : null,
    environment: body.environment === 'teste' ? 'teste' : body.environment === 'producao' ? 'producao' : undefined,
  }));
});

router.get('/orders/:uuid', requireCharge, async (req, res) => {
  send(res, await getPointOrder(String(req.params.uuid)));
});

router.post('/orders/:uuid/cancel', requireCharge, async (req, res) => {
  send(res, await cancelPointOrder(String(req.params.uuid)));
});

router.post('/orders/:uuid/simulate', requireCharge, async (req, res) => {
  const status = (req.body ?? {}).status === 'canceled'
    ? 'canceled'
    : (req.body ?? {}).status === 'expired' ? 'expired' : 'processed';
  send(res, await simulatePointOrder(String(req.params.uuid), status));
});

router.post('/orders/:uuid/refund', requirePermission('kurukpay.orders.refund'), async (req, res) => {
  send(res, await refundPointOrder(String(req.params.uuid)));
});

export default router;
