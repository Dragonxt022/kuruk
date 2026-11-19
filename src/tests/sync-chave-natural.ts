/**
 * Teste do motor de sync: chave natural e isolamento de registro ruim.
 *
 * O caso real que originou isto: a nuvem tinha `capabilities` com um uuid e o PC com
 * outro (instalações antigas geravam uuid aleatório). O pull tentava INSERT, estourava
 * `UNIQUE constraint failed: capabilities.key` e a exceção subia até `runSync`,
 * abortando o lote INTEIRO — 4.422 ciclos sem aplicar nada vindo da nuvem numa loja.
 *
 * Cobre também o registro que não pode ser aplicado de jeito nenhum (NOT NULL): ele é
 * auditado e ignorado, e os seguintes aplicam normalmente.
 *
 *   node scripts/test-isolated.js src/tests/sync-chave-natural.ts
 */
import path from 'node:path';
import type { Request } from 'express';
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { getSqlite, closeDb } from '../core/database/connection';
import { setLicense } from '../core/license/service';
import { registerSyncTables, clearSyncRegistry } from '../core/sync/registry';
import { runSync } from '../core/sync/engine';

let failures = 0;
function check(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

function assertDiscardable(): void {
  const alvo = process.env.KURUK_DB_PATH;
  if (!alvo) throw new Error('KURUK_DB_PATH não definida. Rode via scripts/test-isolated.js.');
  if (path.resolve(alvo) === path.resolve(process.cwd(), 'database', 'kuruk.db')) {
    throw new Error('Recusado: KURUK_DB_PATH aponta para o banco de dev.');
  }
}

const COMPANY = '11111111-1111-4111-8111-111111111111';

const UUID = {
  nuvem: '22222222-2222-4222-8222-222222222222',
  ruim: '33333333-3333-4333-8333-333333333333',
  posterior: '44444444-4444-4444-8444-444444444444',
};

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

async function main(): Promise<void> {
  assertDiscardable();
  migrateUp();
  runSeeds();
  clearSyncRegistry();
  registerSyncTables('core', [{ table: 'capabilities' }]);
  setLicense(COMPANY, 'chave-de-teste', 'diamante', '2099-12-31 23:59:59');
  process.env.KURUK_SYNC_SERVER_URL = 'https://sync.teste.local';

  const db = getSqlite();
  // Linha local com a MESMA chave e outro uuid: é o estado de uma instalação antiga.
  db.prepare(
    `INSERT INTO capabilities (key, description, module, enabled, beta, uuid)
     VALUES ('teste.sync_natural', 'local', 'teste', 0, 0, 'uuid-local')`,
  ).run();

  const page = {
    records: [
      {
        // 1) Mesma capability, uuid diferente na nuvem e mais recente.
        entityType: 'core.capabilities',
        uuid: UUID.nuvem,
        payload: { key: 'teste.sync_natural', description: 'da nuvem', module: 'teste', enabled: 1, beta: 0 },
        updatedAt: '2030-01-01 00:00:00',
        deletedAt: null,
        originMachine: 'maquina-a',
      },
      {
        // 2) Impossível de aplicar: `key` é NOT NULL. Antes, isto derrubava o lote.
        entityType: 'core.capabilities',
        uuid: UUID.ruim,
        payload: { description: 'sem chave', module: 'teste', enabled: 0, beta: 0 },
        updatedAt: '2030-01-01 00:00:00',
        deletedAt: null,
        originMachine: 'maquina-a',
      },
      {
        // 3) Registro novo DEPOIS do problemático: tem de aplicar mesmo assim.
        entityType: 'core.capabilities',
        uuid: UUID.posterior,
        payload: { key: 'teste.sync_posterior', description: 'depois do erro', module: 'teste', enabled: 0, beta: 0 },
        updatedAt: '2030-01-01 00:00:00',
        deletedAt: null,
        originMachine: 'maquina-a',
      },
    ],
    nextCursor: null,
  };

  const originalFetch = global.fetch;
  (global as unknown as { fetch: typeof fetch }).fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes('/api/sync/pull')) return jsonResponse(page);
    if (u.includes('/api/sync/push')) return jsonResponse({ ok: true });
    // Licença/telemetria são best-effort: sem rede aqui, como num restaurante offline.
    throw new Error(`sem rede no teste: ${u}`);
  }) as typeof fetch;

  const req = { headers: {}, ip: null } as unknown as Request;
  let resultado: Awaited<ReturnType<typeof runSync>> | null = null;
  let erro: string | null = null;
  try {
    resultado = await runSync(req);
  } catch (e) {
    erro = e instanceof Error ? e.message : String(e);
  } finally {
    (global as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  }

  check('sync termina sem exception', erro === null, erro ?? '');
  check('sync reporta o pull', Number(resultado?.pulled ?? 0) === 3, JSON.stringify(resultado));

  const natural = db
    .prepare("SELECT uuid, description, enabled, origin_machine FROM capabilities WHERE key = 'teste.sync_natural'")
    .get() as { uuid: string; description: string; enabled: number; origin_machine: string | null } | undefined;
  check('linha local adota o uuid da nuvem', natural?.uuid === UUID.nuvem, String(natural?.uuid));
  check('campos da nuvem são aplicados', natural?.description === 'da nuvem' && Number(natural?.enabled) === 1,
    JSON.stringify(natural));
  check('origem da linha passa a ser a máquina da nuvem', natural?.origin_machine === 'maquina-a',
    String(natural?.origin_machine));

  const posterior = db
    .prepare("SELECT uuid FROM capabilities WHERE key = 'teste.sync_posterior'")
    .get() as { uuid: string } | undefined;
  check('registro posterior ao problemático é aplicado', posterior?.uuid === UUID.posterior, String(posterior?.uuid));

  const ruim = db.prepare('SELECT id FROM capabilities WHERE uuid = ?').get(UUID.ruim) as { id: number } | undefined;
  check('registro impossível não entra no banco', !ruim);

  const acoes = db
    .prepare("SELECT action, COUNT(*) AS n FROM audit_logs WHERE action IN ('sync.reconcile_uuid','sync.apply_failed') GROUP BY action")
    .all() as { action: string; n: number }[];
  const porAcao = new Map(acoes.map((a) => [a.action, Number(a.n)]));
  check('reconciliação fica auditada', (porAcao.get('sync.reconcile_uuid') ?? 0) >= 1, JSON.stringify(acoes));
  check('registro descartado fica auditado', (porAcao.get('sync.apply_failed') ?? 0) >= 1, JSON.stringify(acoes));

  // ─── Registro mais antigo que a linha local não regride o dado ────────────────
  db.prepare(
    `INSERT INTO capabilities (key, description, module, enabled, beta, uuid, updated_at)
     VALUES ('teste.sync_antigo', 'local mais novo', 'teste', 1, 0, 'uuid-antigo-local', '2031-01-01 00:00:00')`,
  ).run();
  const antigo = {
    records: [{
      entityType: 'core.capabilities',
      uuid: '55555555-5555-4555-8555-555555555555',
      payload: { key: 'teste.sync_antigo', description: 'nuvem atrasada', module: 'teste', enabled: 0, beta: 0 },
      updatedAt: '2029-01-01 00:00:00',
      deletedAt: null,
      originMachine: 'maquina-b',
    }],
    nextCursor: null,
  };
  (global as unknown as { fetch: typeof fetch }).fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes('/api/sync/pull')) return jsonResponse(antigo);
    if (u.includes('/api/sync/push')) return jsonResponse({ ok: true });
    throw new Error(`sem rede no teste: ${u}`);
  }) as typeof fetch;
  try {
    await runSync(req);
  } finally {
    (global as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  }
  const naoRegrediu = db
    .prepare("SELECT uuid, description FROM capabilities WHERE key = 'teste.sync_antigo'")
    .get() as { uuid: string; description: string } | undefined;
  check('registro mais antigo não sobrescreve a linha local',
    naoRegrediu?.description === 'local mais novo', JSON.stringify(naoRegrediu));

  closeDb();
  console.log(failures ? `\n${failures} falha(s).` : '\nOK');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
