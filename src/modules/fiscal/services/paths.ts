/**
 * Caminhos de disco do módulo fiscal.
 *
 * Ficam separados do serviço de certificado porque emissão, cancelamento e o próprio
 * upload precisam da MESMA raiz de dados. Antes cada serviço repetia o cálculo de
 * `dirname(dirname(KURUK_DB_PATH))`; com um helper único, um banco de teste em pasta
 * temporária não faz um arquivo cair em outro lugar que o teste não conhece.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Raiz de dados (onde vive `storage/`), ao lado do banco. */
export function dataRoot(): string {
  const dbPath = process.env.KURUK_DB_PATH ?? path.resolve(process.cwd(), 'database', 'kuruk.db');
  return path.dirname(path.dirname(dbPath));
}

/** Raiz dos artefatos fiscais (certificado e XMLs). */
export function fiscalDir(): string {
  return path.join(dataRoot(), 'storage', 'fiscal');
}

/** Pasta dos certificados A1. Criada sob demanda: existe mesmo sem certificado instalado. */
export function certsDir(): string {
  const dir = path.join(fiscalDir(), 'certs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Caminho do XML de um documento, separado por ano/mês como o resto do storage.
 *
 * `relative` vai para o banco (com barras normais, para o backup e o sync não dependerem
 * do separador do Windows); `absolute` é usado na hora de gravar e ler o arquivo.
 */
export function fiscalXmlPath(key: string, suffix = ''): { absolute: string; relative: string } {
  const now = new Date();
  const relative = path.posix.join(
    'storage',
    'fiscal',
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    `${key}${suffix}.xml`,
  );
  const absolute = path.join(dataRoot(), ...relative.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  return { absolute, relative };
}
