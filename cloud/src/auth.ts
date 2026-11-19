import { createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { getPool } from './db';
import { encryptLicenseKey } from './licenseKeyVault';
import { canSaveToCloud } from './plans';

export function hashLicenseKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export interface AuthedRequest extends Request {
  companyUuid?: string;
  companyPlan?: string | null;
}

/**
 * Autenticação mínima da 6a: par company_uuid + license_key (o mesmo já guardado
 * localmente em `license` no Kuruk). Sessão/JWT de verdade fica para a 6b.
 */
export async function requireCompanyAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const companyUuid = req.header('X-Kuruk-Company');
  const licenseKey = req.header('X-Kuruk-License-Key');
  if (!companyUuid || !licenseKey) {
    res.status(401).json({
      error: 'Credenciais ausentes (X-Kuruk-Company / X-Kuruk-License-Key).',
      code: 'credentials_missing',
    });
    return;
  }
  const [rows] = await getPool().query('SELECT license_key_hash, plan, license_key_enc FROM companies WHERE company_uuid = ?', [
    companyUuid,
  ]);
  const company = (rows as { license_key_hash: string; plan: string | null; license_key_enc?: string | null }[])[0];
  // Empresa inexistente = foi excluída (ou nunca existiu) no painel cloud. É diferente de
  // chave errada: o `code` deixa o desktop explicar ao lojista em vez de só "credenciais
  // inválidas". Aqui, empresa some → 404; chave não confere → 401.
  if (!company) {
    res.status(404).json({
      error: 'Empresa não encontrada no servidor (foi excluída ou desativada).',
      code: 'company_not_found',
    });
    return;
  }
  if (company.license_key_hash !== hashLicenseKey(licenseKey)) {
    res.status(401).json({ error: 'Credenciais inválidas.', code: 'invalid_credentials' });
    return;
  }
  // Empresa criada antes do cofre (migration 0059): a próxima validação com a chave
  // correta é a oportunidade de guardar a cópia cifrada. Não bloqueia a requisição nem
  // falha a autenticação se a coluna ainda não existir (deploy sem migration).
  if (!company.license_key_enc) {
    try {
      await getPool().query(
        "UPDATE companies SET license_key_enc = ? WHERE company_uuid = ? AND (license_key_enc IS NULL OR license_key_enc = '')",
        [encryptLicenseKey(licenseKey), companyUuid],
      );
    } catch {
      // Sem a coluna: segue autenticando normalmente; o painel avisa que não há cópia.
    }
  }
  req.companyUuid = companyUuid;
  req.companyPlan = company.plan;
  next();
}

/**
 * Gate por plano comercial (Fase 6e): Trial/Prata não podem salvar dados na nuvem
 * (sync push/pull, upload de backup). Roda depois de `requireCompanyAuth`, que
 * preenche `req.companyPlan`.
 */
export function requireCloudSavePlan(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!canSaveToCloud(req.companyPlan)) {
    res.status(403).json({ error: 'Sincronização/backup em nuvem não incluído neste plano.' });
    return;
  }
  next();
}
