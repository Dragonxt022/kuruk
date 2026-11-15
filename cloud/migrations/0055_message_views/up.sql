-- 0055_message_views — quem visualizou cada mensagem da central.
--
-- O desktop já guarda lido/favorito por USUÁRIO no próprio aparelho. Aqui fica só o
-- recibo de leitura que o suporte precisa enxergar: quando um usuário abre a mensagem,
-- o servidor local avisa a nuvem (POST /api/messages/:uuid/view) com a empresa, o
-- usuário e o aparelho. O par (mensagem, empresa, usuário) é único — reabrir a mesma
-- mensagem atualiza o último acesso e soma em view_count.
--
-- A linha sobrevive à exclusão da empresa? Não: limpamos junto em cascata no código,
-- porque a FK não é usada no restante do schema e a empresa pode ser removida antes.

CREATE TABLE IF NOT EXISTS message_views (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message_id BIGINT UNSIGNED NOT NULL,
  company_uuid CHAR(36) NOT NULL,
  user_key VARCHAR(120) NOT NULL,
  user_name VARCHAR(160) NOT NULL,
  device_name VARCHAR(160) NULL,
  view_count INT UNSIGNED NOT NULL DEFAULT 1,
  first_viewed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_viewed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_message_views_user (message_id, company_uuid, user_key),
  KEY idx_message_views_message (message_id, last_viewed_at),
  KEY idx_message_views_company (company_uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A tabela nasce com o collation padrão do SERVIDOR (utf8mb4_0900_ai_ci no MySQL 8),
-- mas `companies.company_uuid` pode estar em utf8mb4_general_ci/unicode_ci. Sem alinhar,
-- o JOIN da listagem do painel estoura ER_CANT_AGGREGATE_2COLLATIONS. Lê o collation real
-- de `companies` (mesmo padrão das migrations 0017 e 0045).
SET @charset := (
  SELECT CHARACTER_SET_NAME FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'company_uuid'
);
SET @collation := (
  SELECT COLLATION_NAME FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'company_uuid'
);
SET @sql := IF(@charset IS NOT NULL AND @collation IS NOT NULL,
  CONCAT('ALTER TABLE message_views CONVERT TO CHARACTER SET ', @charset, ' COLLATE ', @collation),
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
