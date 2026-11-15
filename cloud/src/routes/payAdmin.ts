import { Router } from 'express';
import { requireAdminAuth } from '../adminAuth';
import {
  disconnectPayAccount, friendlyPayMessage, listPayAccountsForAdmin, listPayOrdersForAdmin,
  loadPayAppSettingsView, normalizePayEnvironment, refreshPayOrder, refundPayOrder,
  savePayAppSettings, serializePayOrder,
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
    await savePayAppSettings((req.body ?? {}) as Record<string, unknown>);
    res.redirect('/admin/pay?ok=' + encodeURIComponent('Credenciais do aplicativo Kuruk Pay salvas.'));
  } catch (e) {
    res.redirect('/admin/pay?error=' + encodeURIComponent((e as Error).message));
  }
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
