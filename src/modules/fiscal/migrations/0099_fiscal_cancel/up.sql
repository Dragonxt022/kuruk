-- 0099_fiscal_cancel — Dados do evento de cancelamento da NFC-e.
--
-- `fiscal_documents` já guardava o protocolo/cStat da AUTORIZAÇÃO. O cancelamento é um
-- evento separado, com protocolo próprio (cStat 135), motivo e XML próprio. Sobrescrever
-- `protocol`/`cstat` apagaria a prova de que a nota chegou a ser autorizada; por isso as
-- colunas são separadas.

ALTER TABLE fiscal_documents ADD COLUMN cancel_protocol TEXT;
ALTER TABLE fiscal_documents ADD COLUMN cancel_cstat INTEGER;
ALTER TABLE fiscal_documents ADD COLUMN cancel_motive TEXT;
ALTER TABLE fiscal_documents ADD COLUMN cancel_xml_path TEXT;
