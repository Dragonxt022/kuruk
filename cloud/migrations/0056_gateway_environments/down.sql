-- Volta a usar apenas as chaves antigas (que foram preservadas pela up.sql).
-- Remove também as chaves por ambiente e a seleção de ambiente.
DELETE FROM app_settings
 WHERE setting_key IN (
   'mp_environment',
   'mp_access_token_teste', 'mp_webhook_secret_teste', 'mp_payer_email_teste',
   'mp_access_token_producao', 'mp_webhook_secret_producao', 'mp_payer_email_producao'
 );
