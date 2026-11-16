import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import { audit } from '../../../core/audit/service';
import { toCsv } from '../../../shared/csv';
import {
  backToHomologation,
  getConfig,
  getEmpresa,
  hasCsc,
  hasProviderToken,
  promoteToProduction,
  saveConfig,
  saveEmpresa,
  setCsc,
  setProviderToken,
  type EmpresaFiscal,
  type FiscalConfig,
} from '../services/config';
import { currentCertificate, generateTestCertificate, removeCertificate, storeCertificate } from '../services/certificate';
import { checkReadiness } from '../services/readiness';
import { listMunicipios } from '../services/municipios';
import { cancelDocument, emitSaleDocument } from '../services/emission';
import { dataRoot } from '../services/paths';
import { fiscalDocumentRepository, fiscalSequenceRepository } from '../repositories/FiscalDocumentRepository';

/** Certificado A1 típico tem entre 2 KB e 20 KB; 1 MB já é folga enorme e evita que um
 * arquivo trocado por engano (um PDF, um ZIP) chegue ao parser. */
const MAX_CERT_BYTES = 1024 * 1024;

function fail(res: Response, message: string, status = 400): void {
  res.status(status).json({ error: message });
}

/** Data do documento para os filtros de período: autorização, senão emissão. */
const DOC_DATE = "date(COALESCE(d.authorized_at, d.emitted_at), 'localtime')";

function documentFilters(req: Request): { whereSql: string; params: unknown[]; from: string; to: string; status: string } {
  const status = String(req.query.status ?? '').trim();
  const from = String(req.query.from ?? '').trim();
  const to = String(req.query.to ?? '').trim();
  const conditions = ['d.deleted_at IS NULL'];
  const params: unknown[] = [];
  if (status) { conditions.push('d.status = ?'); params.push(status); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) { conditions.push(`${DOC_DATE} >= ?`); params.push(from); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) { conditions.push(`${DOC_DATE} <= ?`); params.push(to); }
  return { whereSql: conditions.join(' AND '), params, from, to, status };
}

const DOC_SELECT = `SELECT d.id, d.model, d.serie, d.number, d.environment, d.key, d.status, d.sale_id,
         d.total_cents, d.protocol, d.cstat, d.motive, d.emitted_at, d.authorized_at, d.canceled_at,
         d.is_test, d.xml_path, d.cancel_protocol, d.cancel_cstat, d.cancel_motive, d.cancel_xml_path`;

const ENV_LABEL: Record<number, string> = { 1: 'Produção', 2: 'Homologação' };

function reais(cents: unknown): string {
  return (Math.round(Number(cents ?? 0)) / 100).toFixed(2).replace('.', ',');
}

export const fiscalController = {
  /**
   * Estado completo da configuração numa chamada só — a tela precisa de tudo junto para
   * decidir se abre o assistente ou o painel, e três fetches encadeados só piorariam a
   * primeira renderização.
   *
   * Segredos nunca voltam no corpo: apenas se estão preenchidos.
   */
  getState(_req: Request, res: Response): void {
    const cfg = getConfig();
    res.json({
      config: cfg,
      empresa: getEmpresa(),
      certificado: currentCertificate(),
      temCsc: hasCsc(),
      temToken: hasProviderToken(),
      readiness: checkReadiness(),
      proximoNumero: fiscalSequenceRepository.peek(cfg.modelo, cfg.serie, cfg.ambiente),
    });
  },

  getReadiness(_req: Request, res: Response): void {
    res.json(checkReadiness());
  },

  saveEmpresa(req: Request, res: Response): void {
    const before = getEmpresa();
    saveEmpresa((req.body ?? {}) as Partial<EmpresaFiscal>);
    const after = getEmpresa();
    audit(req, 'editar', 'fiscal_empresa', 'empresa', before, after);
    res.json({ ok: true, empresa: after, readiness: checkReadiness() });
  },

  saveConfig(req: Request, res: Response): void {
    const before = getConfig();
    saveConfig((req.body ?? {}) as Partial<FiscalConfig>);
    const after = getConfig();
    audit(req, 'editar', 'fiscal_config', 'config', before, after);
    res.json({ ok: true, config: after, readiness: checkReadiness() });
  },

  /**
   * Upload do .pfx em base64 no corpo JSON — mesmo caminho das fotos de produto
   * (`express.json({ limit: '10mb' })`), já que o projeto não tem parser de multipart.
   * A senha vem junto e só existe em memória até ir para o cofre.
   */
  uploadCertificate(req: Request, res: Response): void {
    const { pfxBase64, senha } = (req.body ?? {}) as { pfxBase64?: string; senha?: string };
    if (!pfxBase64) return fail(res, 'Envie o arquivo do certificado (.pfx ou .p12).');
    if (!senha) return fail(res, 'Informe a senha do certificado.');

    let buf: Buffer;
    try {
      buf = Buffer.from(String(pfxBase64), 'base64');
    } catch {
      return fail(res, 'Arquivo inválido.');
    }
    if (!buf.length) return fail(res, 'Arquivo vazio.');
    if (buf.length > MAX_CERT_BYTES) return fail(res, 'Arquivo grande demais para ser um certificado A1.');

    const result = storeCertificate(buf, String(senha));
    if (!result.ok) return fail(res, result.error);

    // Nunca logar senha nem conteúdo — só o titular e a validade, que já são exibidos na tela.
    audit(req, 'editar', 'fiscal_certificado', result.info.titular, null, {
      titular: result.info.titular,
      validoAte: result.info.validoAte,
    });
    res.json({ ok: true, certificado: result.info, readiness: checkReadiness() });
  },

  removeCertificate(req: Request, res: Response): void {
    removeCertificate();
    audit(req, 'excluir', 'fiscal_certificado', 'certificado');
    res.json({ ok: true, readiness: checkReadiness() });
  },

  /**
   * Instala um A1 autoassinado para o modo simulado.
   *
   * É o atalho para testar o fluxo inteiro sem um certificado real. Só roda em homologação
   * e só quando não há certificado instalado — trocar um A1 de verdade por um de teste sem
   * avisar seria perigoso.
   */
  generateTestCertificate(req: Request, res: Response): void {
    if (getConfig().ambiente === 1) {
      return fail(res, 'Gere o certificado de teste em homologação. Volte o ambiente antes.');
    }
    if (currentCertificate()) {
      return fail(res, 'Já existe um certificado instalado. Remova-o antes de gerar um certificado de teste.');
    }

    const generated = generateTestCertificate(getEmpresa().cnpj);
    const result = storeCertificate(generated.pfx, generated.password);
    if (!result.ok) return fail(res, result.error);

    audit(req, 'editar', 'fiscal_certificado', result.info.titular, null, {
      titular: result.info.titular,
      validoAte: result.info.validoAte,
      simulado: true,
    });
    res.json({ ok: true, certificado: result.info, readiness: checkReadiness() });
  },

  /** Grava CSC e token. Recebe e descarta — nada disso volta em nenhuma resposta. */
  saveCredentials(req: Request, res: Response): void {
    const { csc, idCsc, provider, token } = (req.body ?? {}) as Record<string, string | undefined>;
    if (csc != null) setCsc(String(csc));
    if (token != null) setProviderToken(String(token));
    if (idCsc != null || provider != null) saveConfig({ idCsc, provider });
    audit(req, 'editar', 'fiscal_credenciais', 'credenciais', null, {
      idCsc: idCsc ?? getConfig().idCsc,
      provider: provider ?? getConfig().provider,
      cscAtualizado: csc != null,
      tokenAtualizado: token != null,
    });
    res.json({ ok: true, temCsc: hasCsc(), temToken: hasProviderToken(), readiness: checkReadiness() });
  },

  async listMunicipios(req: Request, res: Response): Promise<void> {
    try {
      res.json(await listMunicipios(String(req.query.uf ?? '')));
    } catch (e) {
      fail(res, e instanceof Error ? e.message : 'Não foi possível carregar os municípios.');
    }
  },

  /** Trava do beta: só sai de homologação com uma emissão de teste autorizada. */
  setEnvironment(req: Request, res: Response): void {
    const { ambiente } = (req.body ?? {}) as { ambiente?: number };
    if (ambiente !== 1 && ambiente !== 2) return fail(res, 'Ambiente inválido.');

    if (ambiente === 2) {
      backToHomologation();
      audit(req, 'editar', 'fiscal_ambiente', 'ambiente', { ambiente: 1 }, { ambiente: 2 });
      res.json({ ok: true, config: getConfig(), readiness: checkReadiness() });
      return;
    }

    const result = promoteToProduction();
    if (!result.ok) return fail(res, result.error);
    audit(req, 'editar', 'fiscal_ambiente', 'ambiente', { ambiente: 2 }, { ambiente: 1 });
    res.json({ ok: true, config: getConfig(), readiness: checkReadiness() });
  },

  /** Emite a NFC-e de uma venda pelo emissor simulado (homologação). */
  emitDocument(req: Request, res: Response): void {
    const { saleId, simularRejeicao } = (req.body ?? {}) as { saleId?: number; simularRejeicao?: boolean };
    const result = emitSaleDocument(Number(saleId), { forceReject: simularRejeicao === true });

    if (!result.ok) {
      if (result.document) {
        audit(req, 'emitir', 'fiscal_document', result.document.id, null, {
          saleId, status: result.document.status, motivo: result.error,
        });
      }
      res.status(result.status ?? 400).json({ error: result.error });
      return;
    }

    audit(req, 'emitir', 'fiscal_document', result.document.id, null, {
      saleId,
      key: result.document.key,
      status: result.document.status,
      simulado: true,
    });
    res.status(201).json({ ok: true, documento: result.document });
  },

  /** Cancela uma nota autorizada, com evento assinado e XML próprio. */
  cancelDocument(req: Request, res: Response): void {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, 'Documento inválido.');
    const { motivo } = (req.body ?? {}) as { motivo?: string };

    const result = cancelDocument(id, String(motivo ?? ''));
    if (!result.ok) {
      res.status(result.status ?? 400).json({ error: result.error });
      return;
    }

    audit(req, 'cancelar', 'fiscal_document', result.document.id, null, {
      key: result.document.key,
      motivo,
      protocolo: result.document.cancel_protocol,
    });
    res.json({ ok: true, documento: result.document });
  },

  /**
   * Vendas concluídas que ainda podem receber nota.
   *
   * A tela de notas usa esta lista no seletor de emissão: sem ela o lojista teria de
   * decorar o número da venda e digitar em um campo livre.
   */
  listAvailableSales(_req: Request, res: Response): void {
    const rows = fiscalDocumentRepository.raw(
      `SELECT s.id, s.total_cents, s.created_at,
              COALESCE(s.customer_name, c.name) AS customer
         FROM sales s
         LEFT JOIN customers c ON c.id = s.customer_id
        WHERE s.deleted_at IS NULL AND s.status = 'concluida'
          AND NOT EXISTS (
            SELECT 1 FROM fiscal_documents d
             WHERE d.sale_id = s.id AND d.deleted_at IS NULL
               AND d.status IN ('pendente', 'enviando', 'autorizada', 'contingencia')
          )
        ORDER BY s.id DESC
        LIMIT 30`,
    );
    res.json(rows);
  },

  /** Lista as notas emitidas, com filtro de período (autorização/emissão) e status. */
  listDocuments(req: Request, res: Response): void {
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    const { whereSql, params } = documentFilters(req);
    res.json(
      fiscalDocumentRepository.raw(
        `${DOC_SELECT} FROM fiscal_documents d WHERE ${whereSql} ORDER BY d.id DESC LIMIT ?`,
        ...params, limit,
      ),
    );
  },

  /** Resumo do período por status (emitidas, autorizadas, canceladas, rejeitadas...). */
  documentsSummary(req: Request, res: Response): void {
    const { whereSql, params, from, to } = documentFilters(req);
    const rows = fiscalDocumentRepository.raw(
      `SELECT d.status, COUNT(*) AS count, COALESCE(SUM(d.total_cents), 0) AS total_cents
       FROM fiscal_documents d WHERE ${whereSql} GROUP BY d.status ORDER BY d.status`,
      ...params,
    ) as unknown as { status: string; count: number; total_cents: number }[];
    const totals = rows.reduce(
      (acc, r) => ({ count: acc.count + r.count, totalCents: acc.totalCents + r.total_cents }),
      { count: 0, totalCents: 0 },
    );
    res.json({ from, to, byStatus: rows, totals });
  },

  /** Exporta as notas do período em CSV (livro de saída simplificado). */
  exportDocuments(req: Request, res: Response): void {
    const { whereSql, params } = documentFilters(req);
    const rows = fiscalDocumentRepository.raw(
      `${DOC_SELECT} FROM fiscal_documents d WHERE ${whereSql} ORDER BY d.id DESC`,
      ...params,
    ) as Record<string, unknown>[];
    const csv = toCsv([
      ['Número', 'Série', 'Modelo', 'Ambiente', 'Chave de acesso', 'Status', 'Emitida em',
        'Autorizada em', 'Cancelada em', 'Venda', 'Total (R$)', 'Protocolo', 'cStat', 'Motivo'],
      ...rows.map((r) => [
        r.number != null ? String(r.number) : '', r.serie != null ? String(r.serie) : '',
        r.model != null ? String(r.model) : '', ENV_LABEL[Number(r.environment)] ?? String(r.environment ?? ''),
        r.key ? String(r.key) : '', String(r.status ?? ''), String(r.emitted_at ?? ''),
        r.authorized_at ? String(r.authorized_at) : '', r.canceled_at ? String(r.canceled_at) : '',
        r.sale_id != null ? String(r.sale_id) : '', reais(r.total_cents), r.protocol ? String(r.protocol) : '',
        r.cstat != null ? String(r.cstat) : '', r.motive ? String(r.motive) : '',
      ]),
    ]);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="notas-fiscais-${stamp}.csv"`);
    audit(req, 'exportar', 'fiscal_document', 0, null, { total: rows.length, filtros: req.query });
    res.send(csv);
  },

  /** Baixa o XML autorizado do documento (ou o XML do evento de cancelamento). */
  downloadDocumentXml(req: Request, res: Response): void {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, 'Documento inválido.');
    const cancelamento = String(req.query.tipo ?? '') === 'cancelamento';
    const doc = fiscalDocumentRepository.findById(id) as
      | { id: number; key: string | null; xml_path: string | null; cancel_xml_path: string | null }
      | undefined;
    if (!doc) return fail(res, 'Documento não encontrado.', 404);

    const storedPath = cancelamento ? doc.cancel_xml_path : doc.xml_path;
    if (!storedPath) {
      return fail(
        res,
        cancelamento
          ? 'Esta nota ainda não possui XML de cancelamento.'
          : 'O XML da nota ainda não está disponível.',
        404,
      );
    }
    const full = path.isAbsolute(storedPath) ? storedPath : path.join(dataRoot(), storedPath);
    if (!fs.existsSync(full)) {
      return fail(res, 'O arquivo XML não está disponível neste computador.', 404);
    }
    const suffix = cancelamento ? '-cancelamento' : '';
    const filename = doc.key ? `nfe-${doc.key}${suffix}.xml` : `documento-fiscal-${id}${suffix}.xml`;
    audit(req, 'exportar', 'fiscal_document', id, null, { key: doc.key, cancelamento });
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(fs.readFileSync(full));
  },

  getBySale(req: Request, res: Response): void {
    const doc = fiscalDocumentRepository.findBySale(Number(req.params.saleId));
    if (!doc) {
      res.json(null);
      return;
    }
    res.json(doc);
  },
};
