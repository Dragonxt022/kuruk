-- 0097_sale_payments_point — dados da cobrança na maquininha Point (Kuruk Pay).
--
-- Guardar o uuid do pedido no próprio pagamento é o que permite:
--   * mostrar bandeira/parcelas no cupom e no histórico;
--   * estornar a cobrança certa quando a venda for cancelada;
--   * reconciliar a venda com o extrato do Mercado Pago.
--
-- `point_order_uuid` aponta para `pay_orders` no CLOUD (não há FK local: são bancos
-- diferentes). Os outros campos são o retrato devolvido pelo terminal no momento da venda.

ALTER TABLE sale_payments ADD COLUMN point_order_uuid TEXT;
ALTER TABLE sale_payments ADD COLUMN point_brand TEXT;
ALTER TABLE sale_payments ADD COLUMN point_installments INTEGER;
ALTER TABLE sale_payments ADD COLUMN point_payment_type TEXT;
