/**
 * Certificado digital A1 (arquivo .pfx/.p12).
 *
 * Duas responsabilidades: guardar o arquivo fora do banco e ler dele os dados que o lojista
 * precisa VER para confiar que deu certo — titular, CNPJ e validade. Sem esse retorno, subir
 * um certificado é um ato de fé: o lojista não sabe se pegou o arquivo certo, se a senha
 * está correta, nem quando vai vencer.
 *
 * O arquivo vai para `storage/fiscal/certs/`, junto da raiz de dados (mesmo padrão de
 * `productImagesDir()`), NÃO no banco: o backup copia o SQLite para a nuvem, e certificado
 * digital com senha não deve sair da máquina do contribuinte por um caminho que ele não
 * escolheu. A senha vai para o cofre (`core/secrets`).
 *
 * PKCS#12 não é lido pelo `crypto` do Node — daí `node-forge` (JS puro, sem binário nativo,
 * roda igual no Electron empacotado).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import forge from 'node-forge';
import { settingsRepository } from '../../../core/repositories/SettingsRepository';
import { getSecret, setSecret } from '../../../core/secrets/service';
import { SECRET_CERT_PASSWORD } from './config';
import { createLogger } from '../../../core/logger';
import { certsDir } from './paths';

const log = createLogger('fiscal');

export { certsDir } from './paths';

export interface CertificateInfo {
  /** Nome do titular (CN), já sem o sufixo ":CNPJ" que a ICP-Brasil acrescenta. */
  titular: string;
  /** CNPJ extraído do CN, quando presente. */
  cnpj: string | null;
  /** ISO (YYYY-MM-DD) do fim da validade. */
  validoAte: string;
  validoDe: string;
  /** Negativo se já venceu. */
  diasRestantes: number;
  expirado: boolean;
}

export interface SigningMaterial {
  info: CertificateInfo;
  privateKeyPem: string;
  certificatePem: string;
  /** DER do certificado em base64, como vai dentro de `<X509Certificate>`. */
  certificateBase64: string;
}

interface LoadedP12 {
  cert: forge.pki.Certificate;
  privateKey: forge.pki.rsa.PrivateKey | null;
  info: CertificateInfo;
}

function parseAsn1Date(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * O CN dos certificados ICP-Brasil vem como "RAZAO SOCIAL LTDA:12345678000199".
 * Separar os dois deixa a tela mostrar o nome de um jeito legível e ainda permite conferir
 * o CNPJ contra o cadastro da empresa.
 */
function splitCommonName(cn: string): { titular: string; cnpj: string | null } {
  const match = /^(.*?):(\d{11,14})$/.exec(cn.trim());
  if (!match) return { titular: cn.trim(), cnpj: null };
  return { titular: match[1].trim(), cnpj: match[2] };
}

function isCa(cert: forge.pki.Certificate): boolean {
  const basicConstraints = cert.getExtension('basicConstraints') as { cA?: boolean } | undefined;
  return basicConstraints?.cA === true;
}

/**
 * Um .pfx da ICP-Brasil traz a cadeia inteira (raiz + intermediárias + o do titular).
 * O do titular é o único que não assinou ninguém — na prática, o que não é CA.
 */
function pickEntityCertificate(certs: forge.pki.Certificate[]): forge.pki.Certificate {
  return certs.find((c) => !isCa(c)) ?? certs[0];
}

/**
 * Abre o PKCS#12 e devolve certificado, chave privada e os dados do titular.
 *
 * Erro de senha e arquivo inválido são indistinguíveis no PKCS#12 (a senha é o que decifra
 * o conteúdo), então quem chama decide qual mensagem mostrar.
 */
function openP12(pfx: Buffer, password: string): LoadedP12 {
  const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfx.toString('binary')));
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const certs = certBags
    .map((bag) => bag.cert)
    .filter((cert): cert is forge.pki.Certificate => !!cert);
  if (!certs.length) throw new Error('O arquivo não contém nenhum certificado.');

  const shroudedKeyBags =
    p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? [];
  const plainKeyBags = p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? [];
  const privateKey =
    [...shroudedKeyBags, ...plainKeyBags].map((bag) => bag.key).find((key): key is forge.pki.rsa.PrivateKey => !!key) ??
    null;

  const cert = pickEntityCertificate(certs);
  const cnField = cert.subject.getField('CN') as { value?: string } | null;
  const { titular, cnpj } = splitCommonName(cnField?.value ?? 'Titular não identificado');

  const notAfter = cert.validity.notAfter;
  const dias = Math.floor((notAfter.getTime() - Date.now()) / 86_400_000);

  return {
    cert,
    privateKey,
    info: {
      titular,
      cnpj,
      validoDe: parseAsn1Date(cert.validity.notBefore),
      validoAte: parseAsn1Date(notAfter),
      diasRestantes: dias,
      expirado: dias < 0,
    },
  };
}

export function readCertificate(pfx: Buffer, password: string): CertificateInfo {
  return openP12(pfx, password).info;
}

/**
 * Valida, grava o arquivo e guarda a senha no cofre. Só grava depois de conseguir ler:
 * um .pfx que não abre nunca chega ao disco, então o estado salvo é sempre um estado que
 * funciona.
 */
export function storeCertificate(
  pfx: Buffer,
  password: string,
): { ok: true; info: CertificateInfo } | { ok: false; error: string } {
  let info: CertificateInfo;
  try {
    info = readCertificate(pfx, password);
  } catch {
    return {
      ok: false,
      error: 'Não foi possível abrir o certificado. Confira se a senha está correta e se o arquivo é um .pfx ou .p12 válido.',
    };
  }
  if (info.expirado) {
    return { ok: false, error: `Este certificado venceu em ${info.validoAte}. Emita um novo com o seu contador ou a autoridade certificadora.` };
  }

  const file = path.join(certsDir(), 'certificado.pfx');
  fs.writeFileSync(file, pfx, { mode: 0o600 });
  setSecret(SECRET_CERT_PASSWORD, password);
  settingsRepository.set('fiscal.cert_arquivo', file);
  settingsRepository.set('fiscal.cert_titular', info.titular);
  settingsRepository.set('fiscal.cert_validade', info.validoAte);
  return { ok: true, info };
}

/** Estado atual do certificado, relido do disco — nunca do cache em `settings`. */
export function currentCertificate(): CertificateInfo | null {
  const file = settingsRepository.get('fiscal.cert_arquivo');
  const password = getSecret(SECRET_CERT_PASSWORD);
  if (!file || !password || !fs.existsSync(file)) return null;
  try {
    return readCertificate(fs.readFileSync(file), password);
  } catch (e) {
    log.error('certificado gravado não pôde ser lido', e);
    return null;
  }
}

/**
 * Material de assinatura XML (chave privada + certificado).
 *
 * A emissão falha aqui, e não no meio do envio, quando o arquivo existe mas a chave não
 * está disponível. Certificados A3 (token) não entram por este caminho: o PKCS#12 deles
 * não carrega a chave privada exportável, e a mensagem diz exatamente isso.
 */
export function loadSigningMaterial():
  | { ok: true; material: SigningMaterial }
  | { ok: false; error: string } {
  const file = settingsRepository.get('fiscal.cert_arquivo');
  const password = getSecret(SECRET_CERT_PASSWORD);
  if (!file || !password || !fs.existsSync(file)) {
    return { ok: false, error: 'Nenhum certificado A1 instalado. Envie o arquivo .pfx e a senha antes de emitir.' };
  }

  try {
    const loaded = openP12(fs.readFileSync(file), password);
    if (!loaded.privateKey) {
      return {
        ok: false,
        error: 'O certificado não contém uma chave privada exportável. Para emissão automática use um certificado A1 (.pfx), não um token A3.',
      };
    }
    const certAsn1 = forge.pki.certificateToAsn1(loaded.cert);
    return {
      ok: true,
      material: {
        info: loaded.info,
        privateKeyPem: forge.pki.privateKeyToPem(loaded.privateKey),
        certificatePem: forge.pki.certificateToPem(loaded.cert),
        certificateBase64: forge.util.encode64(forge.asn1.toDer(certAsn1).getBytes()),
      },
    };
  } catch {
    return { ok: false, error: 'Não foi possível abrir o certificado instalado. Envie o arquivo novamente.' };
  }
}

export interface GeneratedTestCertificate {
  pfx: Buffer;
  password: string;
  info: CertificateInfo;
}

/**
 * Gera um certificado A1 autoassinado para o modo simulado.
 *
 * É explicitamente um certificado de TESTE: o CN começa com "KURUK TESTE", a validade é
 * curta e a chave privada nunca sai desta máquina. Serve para exercitar upload, leitura,
 * assinatura e o fluxo inteiro de homologação sem depender de um certificado real.
 */
export function generateTestCertificate(cnpj?: string | null): GeneratedTestCertificate {
  const password = randomBytes(18).toString('base64url');
  const keys = forge.pki.rsa.generateKeyPair(2048);

  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = `01${randomBytes(8).toString('hex')}`;
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);

  const digits = String(cnpj ?? '').replace(/\D/g, '');
  const cn = digits.length >= 11 ? `KURUK TESTE:${digits}` : 'KURUK TESTE';
  const attrs = [
    { name: 'commonName', value: cn },
    { name: 'organizationName', value: 'KURUK TESTE' },
    { shortName: 'C', value: 'BR' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', clientAuth: true, emailProtection: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, {
    algorithm: '3des',
    friendlyName: 'Kuruk Teste',
  });
  const pfx = Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), 'binary');
  return { pfx, password, info: readCertificate(pfx, password) };
}

export function removeCertificate(): void {
  const file = settingsRepository.get('fiscal.cert_arquivo');
  if (file && fs.existsSync(file)) fs.rmSync(file, { force: true });
  setSecret(SECRET_CERT_PASSWORD, '');
  settingsRepository.set('fiscal.cert_arquivo', '');
  settingsRepository.set('fiscal.cert_titular', '');
  settingsRepository.set('fiscal.cert_validade', '');
}
