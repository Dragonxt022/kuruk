DROP TABLE IF EXISTS pay_orders;
DROP TABLE IF EXISTS pay_terminals;
DROP TABLE IF EXISTS pay_accounts;
DROP TABLE IF EXISTS pay_oauth_states;
DELETE FROM admin_role_permissions WHERE permission_key = 'pay';
DELETE FROM app_settings
 WHERE setting_key IN ('pay_client_id', 'pay_client_secret', 'pay_webhook_secret');
