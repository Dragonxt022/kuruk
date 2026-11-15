-- 0056_gateway_environments — credenciais de teste e produção convivendo.
--
-- Antes havia um único conjunto de chaves (`mp_access_token`, `mp_webhook_secret`,
-- `mp_payer_email`). Trocar entre sandbox e produção exigia sobrescrever as chaves e
-- depois digitá-las de novo. Agora cada ambiente tem suas chaves, e `mp_environment`
-- diz qual está ativo. A migração copia o conjunto antigo para o ambiente que o token
-- indicava, então nada precisa ser reconfigurado.
--
-- As chaves antigas são mantidas: além de servirem de fallback para produção em
-- instalações que já estavam rodando, apagá-las não traz benefício.

SET @legacy_env := COALESCE((
  SELECT IF(setting_value LIKE 'TEST-%', 'teste', 'producao')
    FROM app_settings
   WHERE setting_key = 'mp_access_token'
     AND setting_value IS NOT NULL
     AND setting_value <> ''
   LIMIT 1
), 'producao');

INSERT IGNORE INTO app_settings (setting_key, setting_value)
SELECT CONCAT('mp_access_token_', @legacy_env), setting_value
  FROM app_settings
 WHERE setting_key = 'mp_access_token'
   AND setting_value IS NOT NULL
   AND setting_value <> '';

INSERT IGNORE INTO app_settings (setting_key, setting_value)
SELECT CONCAT('mp_webhook_secret_', @legacy_env), setting_value
  FROM app_settings
 WHERE setting_key = 'mp_webhook_secret'
   AND setting_value IS NOT NULL
   AND setting_value <> '';

INSERT IGNORE INTO app_settings (setting_key, setting_value)
SELECT CONCAT('mp_payer_email_', @legacy_env), setting_value
  FROM app_settings
 WHERE setting_key = 'mp_payer_email'
   AND setting_value IS NOT NULL
   AND setting_value <> '';

INSERT IGNORE INTO app_settings (setting_key, setting_value)
VALUES ('mp_environment', @legacy_env);
