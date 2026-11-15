import type { ModuleManifest } from '../../core/modules/types';

/**
 * Kuruk Pay — maquininha Point com a conta Mercado Pago do próprio lojista.
 *
 * Produto separado da assinatura do Kuruk: aqui o dinheiro é do lojista e o token é
 * obtido por OAuth no cloud. O app só conhece o estado da conexão e os pedidos — nunca
 * vê o token.
 *
 * O módulo é `alwaysEnabled` de propósito: é configuração/integração, não um recurso
 * comercial que dependa do plano. Quem pode abrir é decidido pelas permissões abaixo.
 */
const manifest: ModuleManifest = {
  id: 'kuruk-pay',
  name: 'Kuruk Pay',
  version: '0.1.0',
  requiresCore: '>=0.1.0',
  alwaysEnabled: true,
  permissions: [
    { key: 'kurukpay.settings.view', description: 'Visualizar a conexão do Kuruk Pay e as cobranças' },
    { key: 'kurukpay.settings.manage', description: 'Conectar/desconectar Mercado Pago e gerenciar terminais' },
    { key: 'kurukpay.orders.view', description: 'Visualizar cobranças enviadas à maquininha' },
    { key: 'kurukpay.orders.charge', description: 'Enviar cobrança para a maquininha Point' },
    { key: 'kurukpay.orders.refund', description: 'Estornar cobrança da maquininha Point' },
  ],
  routes: './routes',
  pages: './pages',
  views: './views',
  menu: [
    {
      label: 'Kuruk Pay',
      href: '/app/kuruk-pay',
      permission: 'kurukpay.settings.view',
      description: 'Maquininha Point e conta Mercado Pago da loja.',
      icon: 'credit-card',
    },
  ],
};

export default manifest;
