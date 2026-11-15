import { Router, type Request, type Response } from 'express';
import { assertAuth } from '../../shared/auth';

/** Página do módulo (montada em /app/kuruk-pay, já autenticada). */
const router = Router();

function renderConfig(req: Request, res: Response): void {
  assertAuth(req);
  if (!req.user.permissions.has('kurukpay.settings.view')) {
    res.redirect('/');
    return;
  }
  res.render('kurukpay-settings', {
    user: req.user,
    canManage: req.user.permissions.has('kurukpay.settings.manage'),
    canCharge: req.user.permissions.has('kurukpay.orders.charge')
      || req.user.permissions.has('store.sales.create'),
    canRefund: req.user.permissions.has('kurukpay.orders.refund'),
  });
}

router.get('/', renderConfig);
router.get('/pedidos', renderConfig);

export default router;
