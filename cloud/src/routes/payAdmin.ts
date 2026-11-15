import { Router } from 'express';
import { requireAdminAuth } from '../adminAuth';
import {
  disconnectPayAccount, friendlyPayMessage, getPayAccount, listPayAccountsForAdmin,
  listPayOrdersForAdmin, loadPayAppSettingsView, normalizePayEnvironment, refreshPayOrder,
  refundPayOrder, savePayAppSettings, serializePayOrder, setCompanyPayEnvironment,
  setPayDefaultEnvironment,
} from '../pay';

/**
 * Kuruk Pay no painel admin: credenciais do APLICATIVO (Client ID/Secret do app
 * "Kuruk-Pay" no Mercado Pago) e visão das contas conectadas pelas empresas.
 *
 * As credenciais são do aplicativo, não da conta: cada lojista autoriza a própria conta
 * pelo OAuth. O segredo nunca volta para a tela.
 */
const router = Router();

function brl(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

router.get('/pay', requireAdminAuth, async (req, res) => {
  const [app, accounts, orders] = await Promise.all([
    loadPayAppSettingsView(),
    listPayAccountsForAdmin(),
    listPayOrdersForAdmin(40),
  ]);
  res.render('admin-pay', {
    app,
    accounts,
    orders: orders.map((o) => ({
      ...serializePayOrder(o),
      companyName: o.company_name,
    })),
    ok: typeof req.query.ok === 'string' ? req.query.ok : null,
    error: typeof req.query.error === 'string' ? req.query.error : null,
    brl,
  });
});

router.post('/pay/settings', requireAdminAuth, async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const environment = normalizePayEnvironment(body.environment);
    await savePayAppSettings(environment, body);
    const label = environment === 'teste' ? 'teste' : 'produção';
    res.redirect('/admin/pay?ok=' + encodeURIComponent(`Credenciais de ${label} salvas.`));
  } catch (e) {
    res.redirect('/admin/pay?error=' + encodeURIComponent((e as Error).message));
  }
});

/** Troca o ambiente PADRÃO para empresas que ainda não escolheram o próprio. */
router.post('/pay/environment', requireAdminAuth, async (req, res) => {
  const environment = normalizePayEnvironment((req.body ?? {}).environment);
  const ok = await setPayDefaultEnvironment(environment);
  if (!ok) {
    const label = environment === 'teste' ? 'teste' : 'produção';
    res.redirect('/admin/pay?error=' + encodeURIComponent(
      `Salve o Client ID e o Client Secret de ${label} antes de ativar este ambiente.`,
    ));
    return;
  }
  const msg = environment === 'teste'
    ? 'Ambiente de teste ativado como padrão. Nenhum valor real será cobrado.'
    : 'Ambiente de produção ativado como padrão.';
  res.redirect('/admin/pay?ok=' + encodeURIComponent(msg));
});

/** Troca o ambiente de UMA empresa com um clique (vale para o app/PDV dela). */
router.post('/pay/companies/:uuid/environment', requireAdminAuth, async (req, res) => {
  const environment = normalizePayEnvironment((req.body ?? {}).environment);
  const companyUuid = String(req.params.uuid);
  const account = await getPayAccount(companyUuid, environment);
  if (!account) {
    res.redirect('/admin/pay?error=' + encodeURIComponent(
      `Esta empresa não tem conta conectada em ${environment === 'teste' ? 'teste' : 'produção'}. Peça para conectar no Kuruk Pay antes de trocar.`,
    ));
    return;
  }
  await setCompanyPayEnvironment(companyUuid, environment);
  res.redirect('/admin/pay?ok=' + encodeURIComponent(
    `Empresa agora está no ambiente de ${environment === 'teste' ? 'teste' : 'produção'}.`,
  ));
});

router.post('/pay/accounts/:uuid/disconnect', requireAdminAuth, async (req, res) => {
  const environment = normalizePayEnvironment((req.body ?? {}).environment);
  const removed = await disconnectPayAccount(String(req.params.uuid), environment);
  res.redirect('/admin/pay?' + (removed
    ? 'ok=' + encodeURIComponent('Conta desconectada.')
    : 'error=' + encodeURIComponent('Conta não encontrada.')));
});

router.post('/pay/orders/:uuid/sync', requireAdminAuth, async (req, res) => {
  try {
    await refreshPayOrder(String(req.params.uuid));
    res.redirect('/admin/pay?ok=' + encodeURIComponent('Cobrança atualizada no Mercado Pago.'));
  } catch (e) {
    res.redirect('/admin/pay?error=' + encodeURIComponent(friendlyPayMessage(e)));
  }
});

router.post('/pay/orders/:uuid/refund', requireAdminAuth, async (req, res) => {
  try {
    await refundPayOrder(String(req.params.uuid));
    res.redirect('/admin/pay?ok=' + encodeURIComponent('Cobrança estornada.'));
  } catch (e) {
    res.redirect('/admin/pay?error=' + encodeURIComponent(friendlyPayMessage(e)));
  }
});

export default router;
