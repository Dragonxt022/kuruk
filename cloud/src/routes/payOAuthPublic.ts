import { Router } from 'express';

/**
 * Página pública de retorno do OAuth do Kuruk Pay.
 *
 * O Mercado Pago devolve o navegador para cá depois que o lojista autoriza a conta.
 * Ela é pública de propósito (o retorno não carrega cookie da licença); o vínculo real
 * foi feito pelo `state` no callback `/api/pay/oauth/callback`.
 */
const router = Router();

router.get('/conectado', (req, res) => {
  const ok = req.query.pay !== 'erro' && req.query.pay !== 'cancelado';
  res.render('pay-conectado', {
    ok,
    cancelado: req.query.pay === 'cancelado',
    origem: typeof req.query.origem === 'string' ? req.query.origem : null,
  });
});

export default router;
