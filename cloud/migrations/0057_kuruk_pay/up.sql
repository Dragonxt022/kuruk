-- 0057_kuruk_pay — Kuruk Pay: integração do lojista com a PRÓPRIA conta Mercado Pago.
--
-- Este é um produto separado do gateway de assinaturas (tabela `charges` + compras do
-- Kuruk). Aqui o dinheiro é do lojista e cai na conta dele: o Kuruk só conversa com a
-- Orders API / Point em nome da empresa conectada, guardando o token OAuth de cada uma.
--
-- Três grupos de dados:
--   * pay_oauth_states — o "state" do OAuth, para casar o retorno com a empresa certa sem
--     confiar em cookie/sessão (o retorno vem do domínio do Mercado Pago).
--   * pay_accounts     — token/refresh por empresa e ambiente (teste/produção).
--   * pay_terminals    — terminais Point da conta, sincronizados sob demanda.
--   * pay_orders       — histórico das cobranças enviadas à maquininha (auditoria e
--     reconciliação; o webhook também usa esta tabela para saber de quem é o pedido).

CREATE TABLE IF NOT EXISTS pay_oauth_states (
  state CHAR(48) NOT NULL,
  company_uuid CHAR(36) NOT NULL,
  environment ENUM('teste', 'producao') NOT NULL DEFAULT 'producao',
  return_url VARCHAR(300) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  PRIMARY KEY (state),
  KEY idx_pay_states_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pay_accounts (
  company_uuid CHAR(36) NOT NULL,
  environment ENUM('teste', 'producao') NOT NULL DEFAULT 'producao',
  mp_user_id VARCHAR(64) NULL,
  nickname VARCHAR(190) NULL,
  email VARCHAR(190) NULL,
  access_token MEDIUMTEXT NULL,
  refresh_token MEDIUMTEXT NULL,
  token_expires_at DATETIME(3) NULL,
  scope VARCHAR(255) NULL,
  live_mode TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('conectado', 'expirado', 'erro') NOT NULL DEFAULT 'conectado',
  last_error VARCHAR(500) NULL,
  default_terminal_id VARCHAR(64) NULL,
  connected_at DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (company_uuid, environment)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pay_terminals (
  company_uuid CHAR(36) NOT NULL,
  environment ENUM('teste', 'producao') NOT NULL DEFAULT 'producao',
  terminal_id VARCHAR(64) NOT NULL,
  name VARCHAR(190) NULL,
  pos_id VARCHAR(64) NULL,
  store_id VARCHAR(64) NULL,
  external_pos_id VARCHAR(64) NULL,
  operating_mode VARCHAR(32) NULL,
  raw_json JSON NULL,
  synced_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (company_uuid, environment, terminal_id),
  KEY idx_pay_terminals_company (company_uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pay_orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  company_uuid CHAR(36) NOT NULL,
  environment ENUM('teste', 'producao') NOT NULL DEFAULT 'producao',
  origin ENUM('pdv', 'painel', 'teste') NOT NULL DEFAULT 'painel',
  external_reference VARCHAR(120) NOT NULL,
  terminal_id VARCHAR(64) NULL,
  amount_cents INT UNSIGNED NOT NULL,
  description VARCHAR(255) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'creating',
  status_detail VARCHAR(64) NULL,
  mp_order_id VARCHAR(64) NULL,
  mp_payment_id VARCHAR(64) NULL,
  payment_type VARCHAR(32) NULL,
  payment_method_id VARCHAR(32) NULL,
  installments INT UNSIGNED NULL,
  refunded_amount_cents INT UNSIGNED NULL,
  sale_uuid CHAR(36) NULL,
  error VARCHAR(500) NULL,
  raw_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_pay_orders_uuid (uuid),
  UNIQUE KEY uk_pay_orders_mp (mp_order_id),
  KEY idx_pay_orders_company (company_uuid, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Alinha o collation de company_uuid com `companies` (mesmo cuidado das migrations
-- 0017, 0045 e 0055): sem isso um JOIN com companies pode estourar
-- ER_CANT_AGGREGATE_2COLLATIONS dependendo de como o banco foi criado.
SET @charset := (
  SELECT CHARACTER_SET_NAME FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'company_uuid'
);
SET @collation := (
  SELECT COLLATION_NAME FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'company_uuid'
);
SET @sql := IF(@charset IS NOT NULL AND @collation IS NOT NULL,
  CONCAT('ALTER TABLE pay_oauth_states CONVERT TO CHARACTER SET ', @charset, ' COLLATE ', @collation),
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(@charset IS NOT NULL AND @collation IS NOT NULL,
  CONCAT('ALTER TABLE pay_accounts CONVERT TO CHARACTER SET ', @charset, ' COLLATE ', @collation),
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(@charset IS NOT NULL AND @collation IS NOT NULL,
  CONCAT('ALTER TABLE pay_terminals CONVERT TO CHARACTER SET ', @charset, ' COLLATE ', @collation),
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(@charset IS NOT NULL AND @collation IS NOT NULL,
  CONCAT('ALTER TABLE pay_orders CONVERT TO CHARACTER SET ', @charset, ' COLLATE ', @collation),
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- O bloco novo do painel precisa entrar no grupo Administrador das instalações que já
-- existiam (a migration 0050 só concedeu os blocos daquela época).
INSERT IGNORE INTO admin_role_permissions (role_id, permission_key)
SELECT id, 'pay' FROM admin_roles WHERE slug = 'administrador';
