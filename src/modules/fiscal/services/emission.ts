/**
 * Emissão e cancelamento de NFC-e no modo simulado.
 *
 * O serviço concentra a ordem que importa: validar configuração e itens ANTES de reservar
 * número, reservar em transação, montar/assinar o XML, ouvir o emissor e só então gravar o
 * documento. Um erro no meio gera um documento `rejeitada` com o motivo, para o lojista
 * enxergar a falha na lista de notas em vez de um 500 sem rastro.
 *
 * A emissão real (emissor externo) entra depois como outro provider; o contrato já está
 * separado em `buildNfceXml` + resposta de autorização.
 */
import fs from 'node:fs';
import crypto, { randomInt, randomUUID } from 'node:crypto';
import { getConfig, getCsc, getEmpresa, markTestPassed, SIMULATED_PROVIDER } from './config';
import { checkReadiness } from './readiness';
import { loadSigningMaterial } from './certificate';
import { fiscalXmlPath } from './paths';
import {
  buildAccessKey,
  buildCancellationEventXml,
  buildNfceXml,
  buildProcNfe,
  buildQrCode,
  onlyDigits,
  ufCode,
  type NfceItemInput,
} from './nfce';
import { authorizeSimulated, cancelSimulated } from './emitters/simulator';
import {
  fiscalDocumentRepository,
  fiscalSequenceRepository,
  type FiscalDocumentRow,
} from '../repositories/FiscalDocumentRepository';

interface SaleRow {
  id: number;
  status: string;
  subtotal_cents: number;
  discount_cents: number;
  surcharge_cents: number;
  total_cents: number;
  payment_method: string;
  customer_id: number | null;
  customer_name: string | null;
  customer_document: string | null;
}

interface SaleItemFiscalRow {
  product_id: number;
  product_name: string;
  qty: number;
  total_cents: number;
  ncm: string | null;
  cest: string | null;
  csosn: string | null;
  cst: string | null;
  origem: number | null;
  unit_fiscal: string | null;
  unit: string | null;
  barcode: string | null;
  sku: string | null;
}

export type EmissionResult =
  | { ok: true; document: FiscalDocumentRow }
  | { ok: false; error: string; status?: number; document?: FiscalDocumentRow };

export type CancellationResult =
  { ok: true; document: FiscalDocumentRow } | { ok: false; error: string; status?: number };

/** Venda e itens que a nota lê. A venda congela nome/preço; o fiscal vem do produto. */
function loadSale(saleId: number): SaleRow | undefined {
  return fiscalDocumentRepository.rawOne(
    `SELECT s.id, s.status, s.subtotal_cents, s.discount_cents, s.surcharge_cents, s.total_cents,
            s.payment_method, s.customer_id,
            COALESCE(s.customer_name, c.name) AS customer_name,
            c.document AS customer_document
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id
      WHERE s.id = ? AND s.deleted_at IS NULL`,
    saleId,
  ) as SaleRow | undefined;
}

function loadItems(saleId: number): SaleItemFiscalRow[] {
  return fiscalDocumentRepository.raw(
    `SELECT si.product_id, si.product_name, si.qty, si.total_cents,
            p.ncm, p.cest, p.csosn, p.cst, p.origem, p.unit_fiscal, p.unit, p.barcode, p.sku
       FROM sale_items si
       JOIN products p ON p.id = si.product_id
      WHERE si.sale_id = ?
      ORDER BY si.id`,
    saleId,
  ) as unknown as SaleItemFiscalRow[];
}

function paymentCode(method: string): string {
  const map: Record<string, string> = {
    dinheiro: '01',
    cartao_credito: '03',
    cartao_debito: '04',
    pix: '17',
    prazo: '99',
    multiplo: '99',
  };
  return map[method] ?? '99';
}

function sqlUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function parseSqlUtc(value: string | null): Date | null {
  if (!value) return null;
  const iso = value.includes('T') ? value : value.replace(' ', 'T');
  const date = new Date(iso.endsWith('Z') ? iso : `${iso}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function insertRejected(input: {
  sale: SaleRow;
  serie: number;
  number: number;
  environment: 1 | 2;
  key: string | null;
  cpfDest: string | null;
  reason: string;
}): FiscalDocumentRow | undefined {
  try {
    const id = fiscalDocumentRepository.create({
      model: '65',
      serie: input.serie,
      number: input.number,
      environment: input.environment,
      key: input.key,
      status: 'rejeitada',
      sale_id: input.sale.id,
      customer_id: input.sale.customer_id,
      cpf_dest: input.cpfDest,
      is_test: input.environment === 2 ? 1 : 0,
      tp_emis: 1,
      total_cents: input.sale.total_cents,
      cstat: 999,
      motive: input.reason,
      provider: SIMULATED_PROVIDER,
      attempts: 1,
      uuid: randomUUID(),
    });
    return fiscalDocumentRepository.findById(id);
  } catch {
    return undefined;
  }
}

/**
 * Emite a NFC-e de uma venda concluída.
 *
 * `forceReject` é um gancho do modo simulado: permite conferir a tela de rejeição sem
 * inventar uma venda inválida. Em um emissor real ele não tem efeito.
 */
export function emitSaleDocument(
  saleId: number,
  opts: { forceReject?: boolean } = {},
): EmissionResult {
  const cfg = getConfig();
  const empresa = getEmpresa();

  if (cfg.provider !== SIMULATED_PROVIDER) {
    return {
      ok: false,
      error: cfg.provider
        ? `O emissor "${cfg.provider}" ainda não está integrado. Use o emissor simulado para testar o fluxo nesta versão.`
        : 'Escolha um emissor na configuração fiscal. Para testar o fluxo, use o emissor simulado.',
    };
  }
  if (cfg.ambiente === 1) {
    return {
      ok: false,
      error:
        'O emissor simulado só emite em homologação. Volte o ambiente para homologação antes de testar.',
    };
  }

  // O NCM global é um diagnóstico da tela; para emitir, valem os itens DESTA venda.
  // Sem essa separação, um produto antigo sem NCM bloqueava a venda que estava pronta.
  const blockers = checkReadiness().checks.filter((c) => c.status === 'fail' && c.id !== 'ncm');
  if (blockers.length) {
    return { ok: false, error: blockers.map((c) => c.detail).join(' ') };
  }

  const sale = loadSale(saleId);
  if (!sale) return { ok: false, error: 'Venda não encontrada.', status: 404 };
  if (sale.status !== 'concluida') {
    return { ok: false, error: 'Só é possível emitir nota para uma venda concluída.' };
  }

  const live = fiscalDocumentRepository.findBySale(saleId);
  if (live && ['pendente', 'enviando', 'autorizada', 'contingencia'].includes(live.status)) {
    return {
      ok: false,
      error: `Esta venda já possui a nota ${live.serie}/${live.number} (${live.status}). Cancele a nota antes de emitir outra.`,
    };
  }

  const rows = loadItems(saleId);
  if (!rows.length) return { ok: false, error: 'Venda sem itens.' };

  const items: NfceItemInput[] = [];
  for (const row of rows) {
    const ncm = onlyDigits(row.ncm);
    if (ncm.length !== 8) {
      return {
        ok: false,
        error: `O produto "${row.product_name}" está sem NCM válido. Preencha os dados fiscais do produto antes de emitir.`,
      };
    }
    const qty = Number(row.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      return { ok: false, error: `Quantidade inválida no item "${row.product_name}".` };
    }
    items.push({
      productId: row.product_id,
      name: row.product_name,
      sku: row.sku,
      barcode: row.barcode,
      ncm,
      cest: row.cest,
      cfop: cfg.cfop,
      unit: row.unit ?? 'un',
      unitFiscal: row.unit_fiscal,
      qty,
      totalCents: Number(row.total_cents),
      csosn: row.csosn,
      cst: row.cst,
      origem: row.origem,
    });
  }

  const customerDocument = onlyDigits(sale.customer_document);
  const cpfDest = customerDocument.length === 11 ? customerDocument : null;

  const number = fiscalSequenceRepository.reserveNext('65', cfg.serie, cfg.ambiente);
  const cNF = String(randomInt(0, 100_000_000)).padStart(8, '0');

  let key: string;
  try {
    key = buildAccessKey({
      cUF: ufCode(empresa.uf),
      cnpj: empresa.cnpj,
      model: '65',
      serie: cfg.serie,
      number,
      tpEmis: 1,
      cNF,
      environment: cfg.ambiente,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Não foi possível montar a chave de acesso.';
    insertRejected({
      sale,
      serie: cfg.serie,
      number,
      environment: cfg.ambiente,
      key: null,
      cpfDest,
      reason: message,
    });
    return { ok: false, error: message };
  }

  const signing = loadSigningMaterial();
  if (!signing.ok) {
    insertRejected({
      sale,
      serie: cfg.serie,
      number,
      environment: cfg.ambiente,
      key,
      cpfDest,
      reason: signing.error,
    });
    return { ok: false, error: signing.error };
  }

  const qr = buildQrCode({
    key,
    environment: cfg.ambiente,
    idCsc: cfg.idCsc || '000001',
    csc: getCsc() ?? 'KURUK-SIMULADO-CSC',
  });

  let built: ReturnType<typeof buildNfceXml>;
  try {
    built = buildNfceXml(
      {
        key,
        environment: cfg.ambiente,
        serie: cfg.serie,
        number,
        emittedAt: new Date(),
        emitente: empresa,
        crt: cfg.crt,
        cfop: cfg.cfop,
        csosnPadrao: cfg.csosnPadrao,
        cstPadrao: cfg.cstPadrao,
        origemPadrao: cfg.origemPadrao,
        subtotalCents: sale.subtotal_cents,
        discountCents: sale.discount_cents,
        surchargeCents: sale.surcharge_cents,
        totalCents: sale.total_cents,
        paymentCode: paymentCode(sale.payment_method),
        items,
        customer:
          sale.customer_name || customerDocument
            ? { name: sale.customer_name ?? 'CONSUMIDOR FINAL', document: customerDocument || null }
            : null,
        qrCode: qr.qrCode,
        urlChave: qr.urlChave,
        isTest: cfg.ambiente === 2,
        saleId,
      },
      signing.material,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Não foi possível montar o XML da nota.';
    insertRejected({
      sale,
      serie: cfg.serie,
      number,
      environment: cfg.ambiente,
      key,
      cpfDest,
      reason: message,
    });
    return { ok: false, error: message };
  }

  const auth = authorizeSimulated({
    key,
    environment: cfg.ambiente,
    digestValue: built.digestValue,
    forceReject: opts.forceReject,
  });

  let xmlPath: string | null = null;
  let xmlHash: string | null = null;
  let absolutePath: string | null = null;

  if (auth.status === 'autorizada') {
    const procXml = buildProcNfe(built.xml, {
      key,
      environment: cfg.ambiente,
      cStat: auth.cStat,
      xMotivo: auth.xMotivo,
      protocol: auth.protocol,
      dhRecbto: auth.dhRecbto,
      digVal: auth.digVal,
    });
    const pathInfo = fiscalXmlPath(key);
    try {
      fs.writeFileSync(pathInfo.absolute, procXml, { mode: 0o600 });
    } catch {
      return { ok: false, error: 'Não foi possível gravar o XML autorizado no disco.', status: 500 };
    }
    absolutePath = pathInfo.absolute;
    xmlPath = pathInfo.relative;
    xmlHash = crypto.createHash('sha256').update(procXml).digest('hex');
  }

  let id: number;
  try {
    id = fiscalDocumentRepository.create({
      model: '65',
      serie: cfg.serie,
      number,
      environment: cfg.ambiente,
      key,
      status: auth.status,
      sale_id: saleId,
      customer_id: sale.customer_id,
      cpf_dest: cpfDest,
      is_test: cfg.ambiente === 2 ? 1 : 0,
      tp_emis: 1,
      total_cents: sale.total_cents,
      protocol: auth.protocol,
      cstat: auth.cStat,
      motive: auth.xMotivo,
      qr_code: qr.qrCode,
      xml_path: xmlPath,
      xml_hash: xmlHash,
      provider: SIMULATED_PROVIDER,
      provider_ref: auth.status === 'autorizada' ? `SIM-${key}` : null,
      attempts: 1,
      authorized_at: auth.dhRecbto,
      uuid: randomUUID(),
    });
  } catch {
    if (absolutePath) fs.rmSync(absolutePath, { force: true });
    return {
      ok: false,
      error: 'Não foi possível registrar o documento fiscal no banco.',
      status: 500,
    };
  }

  if (auth.status === 'autorizada') {
    markTestPassed();
    const document = fiscalDocumentRepository.findById(id);
    return document
      ? { ok: true, document }
      : { ok: false, error: 'Documento emitido, mas não encontrado.', status: 500 };
  }

  const document = fiscalDocumentRepository.findById(id);
  return { ok: false, error: auth.xMotivo, status: 422, document };
}

/**
 * Cancela uma nota autorizada pelo simulado.
 *
 * A janela de 24 horas é deliberadamente maior que os 30 minutos da SEFAZ: é um ambiente
 * de teste, e travar o cancelamento no mesmo dia em que a nota foi emitida só atrapalharia
 * quem está montando o fluxo. A nota continua sendo somente de homologação.
 */
export function cancelDocument(documentId: number, reason: string): CancellationResult {
  const doc = fiscalDocumentRepository.findById(documentId) as FiscalDocumentRow | undefined;
  if (!doc) return { ok: false, error: 'Nota fiscal não encontrada.', status: 404 };
  if (doc.status !== 'autorizada') {
    return {
      ok: false,
      error: `Só é possível cancelar nota autorizada (situação atual: ${doc.status}).`,
    };
  }
  if (doc.provider !== SIMULATED_PROVIDER) {
    return {
      ok: false,
      error: 'O cancelamento está disponível apenas para o emissor simulado nesta versão.',
    };
  }
  if (doc.environment === 1) {
    return { ok: false, error: 'Cancelamento simulado não é permitido em produção.' };
  }
  if (!doc.key) return { ok: false, error: 'A nota não possui chave de acesso.' };

  const authorizedAt = parseSqlUtc(doc.authorized_at);
  if (authorizedAt && Date.now() - authorizedAt.getTime() > 24 * 3600 * 1000) {
    return {
      ok: false,
      error:
        'A nota foi autorizada há mais de 24 horas. O cancelamento simulado só vale no mesmo dia.',
    };
  }

  const motivo = String(reason ?? '').trim();
  if (motivo.length < 15) {
    return { ok: false, error: 'Informe o motivo do cancelamento com pelo menos 15 caracteres.' };
  }

  const empresa = getEmpresa();
  const signing = loadSigningMaterial();
  if (!signing.ok) return { ok: false, error: signing.error };

  const response = cancelSimulated();
  let built: ReturnType<typeof buildCancellationEventXml>;
  try {
    built = buildCancellationEventXml(
      {
        key: doc.key,
        environment: doc.environment as 1 | 2,
        cnpj: empresa.cnpj,
        cUF: ufCode(empresa.uf),
        authorizationProtocol: doc.protocol ?? '',
        reason: motivo,
        occurredAt: new Date(),
        response,
      },
      signing.material,
    );
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Não foi possível montar o evento de cancelamento.',
    };
  }

  const pathInfo = fiscalXmlPath(doc.key, '-cancelamento');
  try {
    fs.writeFileSync(pathInfo.absolute, built.xml, { mode: 0o600 });
  } catch {
    return { ok: false, error: 'Não foi possível gravar o XML de cancelamento no disco.', status: 500 };
  }

  try {
    fiscalDocumentRepository.update(doc.id, {
      status: 'cancelada',
      canceled_at: sqlUtc(new Date()),
      cancel_protocol: response.protocol,
      cancel_cstat: response.cStat,
      cancel_motive: motivo,
      cancel_xml_path: pathInfo.relative,
    });
  } catch {
    fs.rmSync(pathInfo.absolute, { force: true });
    return { ok: false, error: 'Não foi possível registrar o cancelamento no banco.', status: 500 };
  }

  const updated = fiscalDocumentRepository.findById(doc.id);
  return updated
    ? { ok: true, document: updated }
    : { ok: false, error: 'Cancelamento gravado, mas a nota não foi encontrada.', status: 500 };
}
