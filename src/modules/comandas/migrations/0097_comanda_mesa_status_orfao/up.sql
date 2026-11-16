-- 0097_comanda_mesa_status_orfao — reconcilia o espelho `store_tables.status`.
--
-- A regra do módulo é: mesa ocupada ⇔ existe uma comanda `aberta` apontando para ela.
-- O status é um espelho mantido por `openComanda`/`closeComanda`/`cancelComanda`, mas
-- pode ficar defasado: a sincronização aplica a mesa e a comanda como registros
-- separados (a comanda pode falhar numa FK e não chegar), e um fechamento interrompido
-- deixa o status para trás. O sintoma mais visível era o cliente do QR receber
-- "Mesa já está ocupada" numa mesa que estava livre.

-- 1) Ocupada sem nenhuma comanda aberta: a mesa está livre.
UPDATE store_tables
   SET status = 'livre',
       updated_at = datetime('now')
 WHERE deleted_at IS NULL
   AND COALESCE(status, '') <> 'livre'
   AND NOT EXISTS (
     SELECT 1
       FROM comandas c
      WHERE c.table_id = store_tables.id
        AND c.status = 'aberta'
        AND c.deleted_at IS NULL
   );

-- 2) Livre com comanda aberta: a mesa está ocupada (senão a grade abre uma segunda conta).
UPDATE store_tables
   SET status = 'ocupada',
       updated_at = datetime('now')
 WHERE deleted_at IS NULL
   AND COALESCE(status, '') <> 'ocupada'
   AND EXISTS (
     SELECT 1
       FROM comandas c
      WHERE c.table_id = store_tables.id
        AND c.status = 'aberta'
        AND c.deleted_at IS NULL
   );
