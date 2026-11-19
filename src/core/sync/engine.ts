import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { getSqlite } from '../database/connection';
import { audit } from '../audit/service';
import { machineId, refreshLicenseFromCloud, validateLicense } from '../license/service';
import { canSaveToCloud } from '../license/plans';
import { flushTelemetry } from '../telemetry/service';
import { getSyncTables, getRecomputeHook } from './registry';
import {
  tableColumns,
  getUuidById,
  getIdByUuid,
  getRowByUuid,
  getRowById,
  foreignKeyTargets,
  anyExistingId,
} from './introspect';
import { pushBatch, pullBatch } from './client';
import type {
  RegisteredSyncTable,
  SyncChildSpec,
  OutgoingRecord,
  IncomingRecord,
} from './types';

const BATCH_SIZE = 200;
const ALWAYS_SKIP = new Set(['id', 'uuid', 'synced_at', 'origin_machine', 'updated_at', 'deleted_at', 'comment']);

class UnresolvedForeignKeyError extends Error {}

function db() {
  return getSqlite();
}

function nowIso(): string {
  return (db().prepare("SELECT datetime('now') AS now").get() as { now: string }).now;
}

function isLedger(spec: RegisteredSyncTable): boolean {
  return !!spec.ledgerFor;
}

/** Colunas FK efetivas: as declaradas + a coluna de vínculo com o pai, se for ledger. */
function effectiveForeignKeys(spec: RegisteredSyncTable): Record<string, string> {
  const fk = { ...(spec.foreignKeys ?? {}) };
  if (spec.ledgerFor) {
    fk[spec.ledgerFor.parentColumn] = spec.ledgerFor.parentTable;
    Object.assign(fk, spec.ledgerFor.foreignKeys ?? {});
  }
  return fk;
}

// ---------------------------------------------------------------------------
// Coletar linhas alteradas (push)
// ---------------------------------------------------------------------------

const DIRTY_BATCH_SIZE = 500;

function collectDirtyRows(spec: RegisteredSyncTable): Record<string, unknown>[] {
  if (isLedger(spec)) {
    return db().prepare(`SELECT * FROM ${spec.table} WHERE synced_at IS NULL LIMIT ?`).all(DIRTY_BATCH_SIZE) as Record<
      string,
      unknown
    >[];
  }
  return db()
    .prepare(`SELECT * FROM ${spec.table} WHERE synced_at IS NULL OR synced_at < updated_at LIMIT ?`)
    .all(DIRTY_BATCH_SIZE) as Record<string, unknown>[];
}

function buildChildPayload(child: SyncChildSpec, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of tableColumns(child.table).map((c) => c.name)) {
    if (col === 'id' || col === child.parentColumn || ALWAYS_SKIP.has(col)) continue;
    if (child.excludeColumns?.includes(col)) continue;
    out[col] = child.foreignKeys?.[col]
      ? getUuidById(child.foreignKeys[col], row[col] as number | null)
      : row[col];
  }
  return out;
}

function buildOutgoingPayload(spec: RegisteredSyncTable, row: Record<string, unknown>): Record<string, unknown> {
  const fk = effectiveForeignKeys(spec);
  const payload: Record<string, unknown> = {};
  for (const col of tableColumns(spec.table).map((c) => c.name)) {
    if (ALWAYS_SKIP.has(col) || spec.excludeColumns?.includes(col)) continue;
    payload[col] = fk[col] ? getUuidById(fk[col], row[col] as number | null) : row[col];
  }
  for (const child of spec.children ?? []) {
    const rows = db()
      .prepare(`SELECT * FROM ${child.table} WHERE ${child.parentColumn} = ?`)
      .all(row.id) as Record<string, unknown>[];
    payload[child.table] = rows.map((r) => buildChildPayload(child, r));
  }
  return payload;
}

/** Reúne todas as linhas "sujas" de todas as tabelas registradas, prontas para push. */
export function collectOutgoingBatch(): OutgoingRecord[] {
  const machine = machineId();
  const out: OutgoingRecord[] = [];
  for (const spec of getSyncTables()) {
    for (const row of collectDirtyRows(spec)) {
      out.push({
        entityType: spec.entityType,
        uuid: String(row.uuid),
        payload: buildOutgoingPayload(spec, row),
        updatedAt: String(row.updated_at ?? row.created_at),
        deletedAt: row.deleted_at != null ? String(row.deleted_at) : null,
        originMachine: machine,
      });
    }
  }
  return out;
}

function markSynced(records: OutgoingRecord[]): void {
  const byTable = new Map<string, string[]>();
  for (const spec of getSyncTables()) {
    const uuids = records.filter((r) => r.entityType === spec.entityType).map((r) => r.uuid);
    if (uuids.length) byTable.set(spec.table, uuids);
  }
  const ts = nowIso();
  for (const [table, uuids] of byTable) {
    const placeholders = uuids.map(() => '?').join(', ');
    db().prepare(`UPDATE ${table} SET synced_at = ? WHERE uuid IN (${placeholders})`).run(ts, ...uuids);
  }
}

// ---------------------------------------------------------------------------
// Aplicar linhas recebidas (pull)
// ---------------------------------------------------------------------------

/** Traduz o payload recebido em valores de coluna locais; lança se uma FK ainda não existe localmente. */
function payloadToRowValues(spec: RegisteredSyncTable, payload: Record<string, unknown>): Record<string, unknown> {
  const fk = effectiveForeignKeys(spec);
  const values: Record<string, unknown> = {};
  for (const col of tableColumns(spec.table).map((c) => c.name)) {
    if (ALWAYS_SKIP.has(col) || spec.excludeColumns?.includes(col)) continue;
    if (fk[col]) {
      const uuidValue = payload[col] as string | null;
      const localId = getIdByUuid(fk[col], uuidValue);
      if (uuidValue != null && localId == null) {
        throw new UnresolvedForeignKeyError(`FK não resolvida: ${spec.table}.${col} -> ${fk[col]}(${uuidValue})`);
      }
      values[col] = localId;
    } else {
      values[col] = payload[col] ?? null;
    }
  }
  return values;
}

function applyChildren(spec: RegisteredSyncTable, parentLocalId: number, payload: Record<string, unknown>): void {
  for (const child of spec.children ?? []) {
    const rows = (payload[child.table] as Record<string, unknown>[] | undefined) ?? [];
    db().prepare(`DELETE FROM ${child.table} WHERE ${child.parentColumn} = ?`).run(parentLocalId);
    if (!rows.length) continue;
    const CHILD_SKIP = new Set(['id', 'synced_at', 'origin_machine', 'updated_at', 'deleted_at', 'comment']);
    const cols = tableColumns(child.table)
      .map((c) => c.name)
      .filter((n) => !CHILD_SKIP.has(n) && n !== child.parentColumn && !child.excludeColumns?.includes(n));
    const insertCols = [child.parentColumn, ...cols];
    const stmt = db().prepare(
      `INSERT INTO ${child.table} (${insertCols.join(', ')}) VALUES (${insertCols.map(() => '?').join(', ')})`,
    );
    for (const r of rows) {
      const values = cols.map((c) => {
        if (c === 'uuid') return (r[c] as string) ?? randomUUID();
        if (!child.foreignKeys?.[c]) return r[c] ?? null;
        const uuidValue = r[c] as string | null;
        const localId = getIdByUuid(child.foreignKeys[c], uuidValue);
        if (uuidValue != null && localId == null) {
          throw new UnresolvedForeignKeyError(
            `FK não resolvida (filho): ${child.table}.${c} -> ${child.foreignKeys[c]}(${uuidValue})`,
          );
        }
        return localId;
      });
      stmt.run(parentLocalId, ...values);
    }
  }
}

/**
 * Colunas derivadas (excludeColumns) ficam de fora do payload — mas se forem NOT NULL
 * sem DEFAULT no schema (ex.: stock_movements.balance_after), o INSERT precisa de um
 * placeholder. É seguro: o hook de recompute (ex.: recomputeStockForProducts) corrige
 * o valor real logo em seguida, antes de qualquer leitura.
 */
function placeholdersForExcluded(spec: RegisteredSyncTable): Record<string, unknown> {
  const fkTargets = foreignKeyTargets(spec.table);
  const values: Record<string, unknown> = {};
  for (const col of tableColumns(spec.table)) {
    if (!spec.excludeColumns?.includes(col.name) || !col.notNull || col.hasDefault) continue;
    const refTable = fkTargets.get(col.name);
    // FK real para tabela não sincronizada (ex.: users): usa qualquer id local existente
    // (toda instalação tem ao menos o admin seedado). Sem FK (ex.: balance_after): usa 0.
    values[col.name] = refTable ? anyExistingId(refTable) : 0;
  }
  return values;
}

// ---------------------------------------------------------------------------
// Chave natural (mesma linha lógica, uuid diferente)
// ---------------------------------------------------------------------------

const uniqueIndexCache = new Map<string, string[][]>();

/** Colunas de cada índice UNIQUE da tabela — inclusive o UNIQUE(key) criado pela migration. */
function uniqueIndexKeys(table: string): string[][] {
  const cached = uniqueIndexCache.get(table);
  if (cached) return cached;
  const indexes = db().prepare(`PRAGMA index_list(${table})`).all() as
    { name: string; unique: number; partial: number }[];
  const keys: string[][] = [];
  for (const idx of indexes) {
    if (!idx.unique || idx.partial) continue;
    const cols = (db().prepare(`PRAGMA index_info(${idx.name})`).all() as { name: string | null }[])
      .map((c) => c.name)
      .filter((n): n is string => !!n);
    if (cols.length) keys.push(cols);
  }
  uniqueIndexCache.set(table, keys);
  return keys;
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
}

/**
 * Procura a linha local que já representa o MESMO registro lógico (chave natural igual),
 * mesmo tendo outro uuid.
 *
 * A nuvem pode ter a mesma linha com outro uuid: `capabilities` é o caso real — instalações
 * antigas geravam `randomUUID()` por máquina e versões novas derivam um uuid estável da
 * chave, então a nuvem guardava um e o PC tinha outro. O motor casa por uuid, tentava
 * INSERT e estourava o UNIQUE da chave natural.
 */
function findNaturalKeyConflict(
  spec: RegisteredSyncTable,
  values: Record<string, unknown>,
  incomingUuid: string,
): { localId: number } | null {
  for (const columns of uniqueIndexKeys(spec.table)) {
    const params: unknown[] = [];
    let usable = true;
    for (const col of columns) {
      const value = col === 'uuid' ? incomingUuid : values[col];
      if (value === undefined || value === null) { usable = false; break; }
      params.push(value);
    }
    if (!usable) continue;
    const row = db()
      .prepare(`SELECT id, uuid FROM ${spec.table} WHERE ${columns.map((c) => `${c} = ?`).join(' AND ')} LIMIT 1`)
      .get(...params) as { id: number; uuid: string } | undefined;
    if (row && String(row.uuid) !== incomingUuid) return { localId: Number(row.id) };
  }
  return null;
}

/**
 * Mesma entidade, uuid diferente: a linha local adota o uuid da nuvem (a nuvem é a fonte
 * da identidade — o uuid local é o que cada máquina inventou, então o que vale é o que já
 * está publicado). O registro recebido só sobrescreve se for mais recente; se for mais
 * antigo, a linha local vale e será empurrada no próximo push.
 */
function reconcileNaturalKey(
  req: Request,
  spec: RegisteredSyncTable,
  localId: number,
  rec: IncomingRecord,
): number {
  const local = getRowById(spec.table, localId);
  if (!local) throw new Error(`Linha ${spec.table}#${localId} sumiu durante a reconciliação.`);
  const localUpdatedAt = String(local.updated_at ?? '');
  if (rec.updatedAt < localUpdatedAt) {
    audit(req, 'sync.reconcile_ignored', spec.table, localId, null, {
      uuid: rec.uuid, motivo: 'registro recebido é mais antigo que a linha local',
    });
    return localId;
  }
  const values = payloadToRowValues(spec, rec.payload);
  const cols = Object.keys(values);
  const sets = cols
    .map((c) => `${c} = ?`)
    .concat(['uuid = ?', 'updated_at = ?', 'deleted_at = ?', 'synced_at = ?', 'origin_machine = ?'])
    .join(', ');
  db()
    .prepare(`UPDATE ${spec.table} SET ${sets} WHERE id = ?`)
    .run(...cols.map((c) => values[c]), rec.uuid, rec.updatedAt, rec.deletedAt, nowIso(), rec.originMachine, localId);
  applyChildren(spec, localId, rec.payload);
  audit(req, 'sync.reconcile_uuid', spec.table, localId, { uuid: String(local.uuid ?? '') }, { uuid: rec.uuid });
  return localId;
}

function insertNewRow(req: Request, spec: RegisteredSyncTable, rec: IncomingRecord): number {
  const values = { ...placeholdersForExcluded(spec), ...payloadToRowValues(spec, rec.payload) };
  const cols = Object.keys(values);
  const isLedgerTable = isLedger(spec);
  const controlCols = isLedgerTable ? ['uuid', 'synced_at', 'origin_machine'] : ['uuid', 'updated_at', 'deleted_at', 'synced_at', 'origin_machine'];
  const allCols = [...cols, ...controlCols];
  let localId: number;
  try {
    const info = db()
      .prepare(`INSERT INTO ${spec.table} (${allCols.join(', ')}) VALUES (${allCols.map(() => '?').join(', ')})`)
      .run(
        ...cols.map((c) => values[c]),
        rec.uuid,
        ...(isLedgerTable ? [] : [rec.updatedAt, rec.deletedAt]),
        nowIso(),
        rec.originMachine,
      );
    localId = Number(info.lastInsertRowid);
  } catch (e) {
    // Ledger é append-only por uuid: conflito ali é dado corrompido, não reconciliação.
    if (!isLedgerTable && isUniqueViolation(e)) {
      const conflict = findNaturalKeyConflict(spec, values, rec.uuid);
      if (conflict) return reconcileNaturalKey(req, spec, conflict.localId, rec);
    }
    throw e;
  }
  if (!isLedgerTable) applyChildren(spec, localId, rec.payload);
  return localId;
}

function updateRow(req: Request, spec: RegisteredSyncTable, local: Record<string, unknown>, rec: IncomingRecord): void {
  const localId = Number(local.id);
  const localUpdatedAt = String(local.updated_at);
  const localSyncedAt = local.synced_at != null ? String(local.synced_at) : null;
  const localWasDirty = localSyncedAt === null || localUpdatedAt > localSyncedAt;
  // Edição concorrente: o último autor local difere de quem escreveu o valor que está chegando.
  // Complementa `localWasDirty` — sozinho, `synced_at` não sobrevive a rodadas de sync já
  // confirmadas antes de o conflito real aparecer (a própria máquina já marcou seu push como
  // sincronizado antes de saber da edição concorrente de outra máquina).
  const localOrigin = local.origin_machine != null ? String(local.origin_machine) : null;
  const differentAuthor = localOrigin != null && localOrigin !== rec.originMachine;

  const incomingWins =
    rec.updatedAt > localUpdatedAt ||
    (rec.updatedAt === localUpdatedAt && rec.originMachine > String(local.origin_machine ?? ''));
  if (!incomingWins) return; // local vence; será enviado no próximo push

  if (localWasDirty || differentAuthor) {
    audit(req, 'sync.conflict', spec.table, localId, local, rec.payload);
  }
  const values = payloadToRowValues(spec, rec.payload);
  const cols = Object.keys(values);
  const sets = cols
    .map((c) => `${c} = ?`)
    .concat(['updated_at = ?', 'deleted_at = ?', 'synced_at = ?', 'origin_machine = ?'])
    .join(', ');
  db()
    .prepare(`UPDATE ${spec.table} SET ${sets} WHERE id = ?`)
    .run(...cols.map((c) => values[c]), rec.updatedAt, rec.deletedAt, nowIso(), rec.originMachine, localId);
  applyChildren(spec, localId, rec.payload);
}

type PendingRecompute = Map<string, Set<number>>;

function applyIncomingRecord(req: Request, spec: RegisteredSyncTable, rec: IncomingRecord, pending: PendingRecompute): number | null {
  if (isLedger(spec)) {
    const existing = getRowByUuid(spec.table, rec.uuid);
    if (existing) return null; // append-only: já aplicado
    const localId = insertNewRow(req, spec, rec);
    const hook = getRecomputeHook(spec.table);
    if (hook) {
      const inserted = getRowById(spec.table, localId)!;
      const parentLocalId = Number(inserted[spec.ledgerFor!.parentColumn]);
      if (!pending.has(spec.table)) pending.set(spec.table, new Set());
      pending.get(spec.table)!.add(parentLocalId);
    }
    return localId;
  }
  const local = getRowByUuid(spec.table, rec.uuid);
  if (!local) return insertNewRow(req, spec, rec);
  updateRow(req, spec, local, rec);
  return Number(local.id);
}

async function applyIncomingBatch(req: Request, records: IncomingRecord[]): Promise<void> {
  const byEntityType = new Map(getSyncTables().map((s) => [s.entityType, s]));
  const pending: PendingRecompute = new Map();
  let queue = records;
  const lastError = new Map<string, { reason: string; foreignKey: boolean }>();
  for (let attempt = 0; attempt < 3 && queue.length; attempt++) {
    const next: IncomingRecord[] = [];
    for (const rec of queue) {
      const spec = byEntityType.get(rec.entityType);
      if (!spec) continue;
      try {
        applyIncomingRecord(req, spec, rec, pending);
      } catch (e) {
        /**
         * Um registro problemático NÃO pode derrubar o lote inteiro. Antes disto, uma
         * exceção que não fosse FK fora de ordem (ex.: `UNIQUE constraint failed:
         * capabilities.key`) subia até `runSync` e abortava o pull por completo — numa
         * loja real isso significou 4.422 ciclos sem aplicar NADA vindo da nuvem.
         * Retenta dentro do lote (FK fora de ordem se resolve na rodada seguinte) e, se
         * persistir, audita e segue: o registro volta na próxima mudança.
         */
        next.push(rec);
        lastError.set(rec.uuid, {
          reason: e instanceof Error ? e.message : String(e),
          foreignKey: e instanceof UnresolvedForeignKeyError,
        });
      }
    }
    queue = next;
  }
  for (const rec of queue) {
    const info = lastError.get(rec.uuid);
    audit(req, info?.foreignKey ? 'sync.unresolved_fk' : 'sync.apply_failed', rec.entityType, undefined, null, {
      uuid: rec.uuid,
      reason: info?.reason,
    });
  }
  for (const [table, ids] of pending) {
    const hook = getRecomputeHook(table);
    if (hook) await hook([...ids]);
  }
}

// ---------------------------------------------------------------------------
// Orquestração
// ---------------------------------------------------------------------------

async function pushAll(): Promise<number> {
  const outgoing = collectOutgoingBatch();
  let count = 0;
  for (let i = 0; i < outgoing.length; i += BATCH_SIZE) {
    const batch = outgoing.slice(i, i + BATCH_SIZE);
    await pushBatch(machineId(), batch);
    markSynced(batch);
    count += batch.length;
  }
  return count;
}

async function pullAll(req: Request): Promise<number> {
  let cursor: string | null = null;
  let count = 0;
  do {
    const page = await pullBatch(cursor);
    await applyIncomingBatch(req, page.records);
    count += page.records.length;
    cursor = page.nextCursor;
  } while (cursor);
  return count;
}

export async function runSync(req: Request): Promise<{ pushed: number; pulled: number; skipped?: boolean }> {
  // Telemetria (erros + inventário) pega carona no ciclo do sync e não depende do plano —
  // trial/prata também mandam. Best-effort: nunca atrapalha o sync.
  flushTelemetry().catch(() => { /* best-effort */ });
  // Reconectar também confirma entitlement/validade (Fase 6b) — best-effort, não
  // interrompe o resto do sync se o cloud/ estiver fora do ar. Módulos são checados
  // dinamicamente por requisição (não só no boot), então o plano atualizado aqui já
  // reflete imediatamente no restante do app.
  await refreshLicenseFromCloud();
  if (!canSaveToCloud(validateLicense().plan)) {
    return { pushed: 0, pulled: 0, skipped: true };
  }
  const pushed = await pushAll();
  const pulled = await pullAll(req);
  return { pushed, pulled };
}
