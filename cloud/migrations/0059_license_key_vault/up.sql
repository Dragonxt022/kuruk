-- 0059_license_key_vault — guarda uma cópia cifrada da chave de licença.
--
-- Até aqui o Cloud só guardava o hash da chave. O painel mostrava a chave uma única vez,
-- na criação, e depois não tinha como reenviá-la ao cliente que perdesse o e-mail. A
-- coluna abaixo recebe a chave cifrada com AES-256-GCM (ver src/licenseKeyVault.ts); a
-- autenticação continua sendo feita exclusivamente pelo hash.
ALTER TABLE companies ADD COLUMN license_key_enc VARCHAR(255) NULL AFTER license_key_hash;
