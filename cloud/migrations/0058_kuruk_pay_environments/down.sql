DROP TABLE IF EXISTS pay_company_settings;
DELETE FROM app_settings
 WHERE setting_key IN ('pay_environment', 'pay_client_id_teste', 'pay_client_secret_teste', 'pay_webhook_secret_teste');
