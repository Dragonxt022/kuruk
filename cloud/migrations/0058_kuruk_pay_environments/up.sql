-- 0058_kuruk_pay_environments — ambiente ativo do Kuruk Pay por empresa.
--
-- As credenciais do APLICATIVO (Client ID/Secret) de teste e produção ficam em
-- `app_settings` (chaves diferentes). O que faltava era lembrar, por empresa, qual
-- ambiente ela está usando: o lojista pode testar na conta de teste e voltar para
-- produção com um clique, sem perder a conexão do outro ambiente.
--
-- `pay_environment` em `app_settings` é o PADRÃO para empresas que ainda não escolheram.
-- A linha em `pay_company_settings` é a escolha explícita da empresa e vence o padrão.

CREATE TABLE IF NOT EXISTS pay_company_settings (
  company_uuid CHAR(36) NOT NULL,
  active_environment ENUM('teste', 'producao') NOT NULL DEFAULT 'producao',
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (company_uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Alinha o collation com `companies` (mesmo cuidado das outras migrations).
SET @charset := (
  SELECT CHARACTER_SET_NAME FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'company_uuid'
);
SET @collation := (
  SELECT COLLATION_NAME FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'company_uuid'
);
SET @sql := IF(@charset IS NOT NULL AND @collation IS NOT NULL,
  CONCAT('ALTER TABLE pay_company_settings CONVERT TO CHARACTER SET ', @charset, ' COLLATE ', @collation),
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

INSERT IGNORE INTO app_settings (setting_key, setting_value)
VALUES ('pay_environment', 'producao');
