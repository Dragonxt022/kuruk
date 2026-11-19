import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Cofre das chaves de licença do Cloud.
 *
 * A autenticação das empresas continua usando só o HASH (`license_key_hash`): a chave
 * nunca é comparada em texto puro. Mas o painel administrativo precisa conseguir
 * reenviar a chave ao cliente que perdeu o e-mail de ativação — e um hash não volta
 * atrás. Por isso o Cloud guarda também uma cópia CIFRADA (AES-256-GCM), que só este
 * módulo abre.
 *
 * A chave-mestra vem de `LICENSE_KEY_VAULT_SECRET`. Sem a variável, o Cloud gera
 * `storage/license-vault.key` na primeira gravação (0600, fora do Git). O arquivo
 * precisa sobreviver a reinícios/deploys; se ele se perder, as chaves antigas não
 * podem mais ser reveladas — o caminho passa a ser gerar uma nova chave na empresa.
 */
const ALGORITHM = 'aes-256-gcm';
const KEY_FILE = path.resolve(process.cwd(), 'storage', 'license-vault.key');
const KEY_BYTES = 32;
/** Versão do formato para permitir troca de algoritmo no futuro sem adivinhar. */
const FORMAT_VERSION = 'v1';

let cachedKey: Buffer | null = null;

function vaultKey(): Buffer {
  if (cachedKey) return cachedKey;

  const fromEnv = String(process.env.LICENSE_KEY_VAULT_SECRET ?? '').trim();
  if (fromEnv) {
    cachedKey = scryptSync(fromEnv, 'kuruk-license-vault-v1', KEY_BYTES);
    return cachedKey;
  }

  try {
    const saved = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'base64');
    if (saved.length === KEY_BYTES) {
      cachedKey = saved;
      return cachedKey;
    }
  } catch {
    // Primeiro uso: o arquivo ainda não existe.
  }

  cachedKey = randomBytes(KEY_BYTES);
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  fs.writeFileSync(KEY_FILE, cachedKey.toString('base64'), { mode: 0o600 });
  return cachedKey;
}

/** Cifra uma chave de licença para guardar em `companies.license_key_enc`. */
export function encryptLicenseKey(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, vaultKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [
    FORMAT_VERSION,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

/**
 * Devolve a chave em texto puro. `null` quando não há cópia (empresa antiga, gerada
 * antes do cofre) ou quando a cópia não abre com a chave-mestra atual.
 */
export function decryptLicenseKey(stored: string | null | undefined): string | null {
  const value = String(stored ?? '').trim();
  if (!value) return null;
  const parts = value.split(':');
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) return null;
  try {
    const decipher = createDecipheriv(ALGORITHM, vaultKey(), Buffer.from(parts[1], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]);
    return plain.toString('utf8');
  } catch {
    return null;
  }
}
