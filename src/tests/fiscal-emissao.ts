/**
 * Teste do fluxo de emissão simulada de NFC-e (F2 — emissor simulado).
 *
 * Cobre o caminho completo que o lojista percorre para "montar o fluxo":
 * 1. configuração da empresa e diagnóstico de prontidão;
 * 2. certificado A1 de teste gerado pelo próprio servidor (upload/leitura/senha no cofre);
 * 3. emissor simulado (sem CSC/token reais);
 * 4. venda no PDV, reserva de número, XML assinado, chave de 44 dígitos e autorização 100;
 * 5. arquivamento do XML, download e QR Code;
 * 6. rejeição simulada e nova tentativa com outro número;
 * 7. cancelamento com evento 110111 e XML próprio;
 * 8. trava de produção (simulado só em homologação).
 *
 * Uso:
 *   node scripts/test-isolated.js src/tests/fiscal-emissao.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import forge from 'node-forge';
import { migrateUp } from '../core/database/migrator';
import { runSeeds } from '../core/database/seeds';
import { createServer } from '../core/server';
import { getSqlite, closeDb } from '../core/database/connection';
import { deleteSecret } from '../core/secrets/service';
import { resetTestDb, activateTestLicense } from './resetTestDb';
import { unwrap, type ApiRow } from './testUtils';
import { certsDir, dataRoot } from '../modules/fiscal/services/paths';
import { SECRET_CERT_PASSWORD } from '../modules/fiscal/services/config';

const PORT = Number(process.env.KURUK_PORT ?? 3621);
const base = `http://localhost:${PORT}`;
let failures = 0;

function check(label: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

async function api(pathname: string, opts: RequestInit = {}, cookie?: string) {
  return fetch(`${base}${pathname}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(opts.headers ?? {}),
    },
  });
}

async function loginAs(u: string, p: string): Promise<string | null> {
  const r = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: u, password: p }),
  });
  if (!r.ok) return null;
  const m = (r.headers.get('set-cookie') ?? '').match(/kuruk_session=([^;]+)/);
  return m ? `kuruk_session=${m[1]}` : null;
}

function limparCertificadoDeTeste(): void {
  try {
    fs.rmSync(path.join(certsDir(), 'certificado.pfx'), { force: true });
  } catch {
    /* arquivo já inexistente */
  }
  try {
    deleteSecret(SECRET_CERT_PASSWORD);
  } catch {
    /* cofre ainda não existe */
  }
}

/**
 * Confere, sem biblioteca de XMLDSig, o que a assinatura promete:
 * - o digest SHA-1 do `infNFe` canônico bate com o `DigestValue`;
 * - o `SignedInfo` foi assinado pela chave privada do certificado embutido no XML.
 */
function verificarAssinaturaNfe(xml: string): { digestOk: boolean; signatureOk: boolean } {
  const infMatch = /<infNFe Id="([^"]+)" versao="[^"]+">([\s\S]*?)<\/infNFe>/.exec(xml);
  const digestMatch = /<DigestValue>([^<]+)<\/DigestValue>/.exec(xml);
  const signedInfoMatch = /<SignedInfo[^>]*>[\s\S]*?<\/SignedInfo>/.exec(xml);
  const signatureMatch = /<SignatureValue>([^<]+)<\/SignatureValue>/.exec(xml);
  const certMatch = /<X509Certificate>([^<]+)<\/X509Certificate>/.exec(xml);
  if (!infMatch || !digestMatch || !signedInfoMatch || !signatureMatch || !certMatch) {
    return { digestOk: false, signatureOk: false };
  }

  const canonical = `<infNFe xmlns="http://www.portalfiscal.inf.br/nfe" Id="${infMatch[1]}" versao="4.00">${infMatch[2]}</infNFe>`;
  const digest = crypto.createHash('sha1').update(canonical, 'utf8').digest('base64');

  const base64 = certMatch[1].replace(/\s+/g, '');
  const pem = `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/g)?.join('\n') ?? base64}\n-----END CERTIFICATE-----`;
  const cert = forge.pki.certificateFromPem(pem);
  const publicKeyPem = forge.pki.publicKeyToPem(cert.publicKey);
  const signatureOk = crypto
    .createVerify('RSA-SHA1')
    .update(signedInfoMatch[0], 'utf8')
    .verify(publicKeyPem, signatureMatch[1], 'base64');

  return { digestOk: digest === digestMatch[1], signatureOk };
}

/** Dígito verificador da chave (módulo 11) para conferir o cálculo do serviço. */
function digitoChave(base43: string): number {
  let weight = 2;
  let sum = 0;
  for (let i = base43.length - 1; i >= 0; i--) {
    sum += Number(base43[i]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

/** Gera um PKCS#12 autoassinado para exercitar o upload manual de certificado. */function criarPfxTeste(cnpj: string): { base64: string; senha: string } {
  const senha = 'senha-do-certificado-teste';
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = `01${crypto.randomBytes(8).toString('hex')}`;
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
  const attrs = [
    { name: 'commonName', value: `KURUK TESTE:${cnpj}` },
    { name: 'organizationName', value: 'KURUK TESTE' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], senha, { algorithm: '3des' });
  return { base64: forge.util.encode64(forge.asn1.toDer(p12).getBytes()), senha };
}

async function main() {
  limparCertificadoDeTeste();
  resetTestDb();
  migrateUp();
  runSeeds();
  activateTestLicense();
  const { app } = await createServer();
  const server = app.listen(PORT);
  const db = getSqlite();

  const admin = await loginAs('admin', 'admin');
  check('login admin', admin !== null);

  // Licença ativa + capability: o módulo nasce desligado.
  const enable = await api(
    '/api/core/capabilities/fiscal.nfce',
    { method: 'PUT', body: JSON.stringify({ enabled: true }) },
    admin!,
  );
  check('ativa a capability fiscal.nfce', enable.status === 200);

  const paginaNotas = await fetch(`${base}/app/fiscal/notas`, { headers: { cookie: admin! } });
  const htmlNotas = await paginaNotas.text();
  check(
    'página de notas renderiza o seletor de emissão',
    paginaNotas.status === 200 && htmlNotas.includes('Emitir nota de uma venda'),
    String(paginaNotas.status),
  );

  const paginaConfig = await fetch(`${base}/app/fiscal/configuracao`, { headers: { cookie: admin! } });
  const htmlConfig = await paginaConfig.text();
  check(
    'página de configuração renderiza a geração de certificado de teste',
    paginaConfig.status === 200 && htmlConfig.includes('Gerar certificado de teste'),
    String(paginaConfig.status),
  );

  // ---------- 1. Empresa ----------
  const empresa = {
    razaoSocial: 'KURUK TESTE LTDA',
    nomeFantasia: 'Kuruk Teste',
    cnpj: '11.222.333/0001-81',
    ie: '123456789',
    cep: '41010-000',
    rua: 'Rua de Teste',
    numero: '100',
    complemento: '',
    bairro: 'Centro',
    cidade: 'Salvador',
    uf: 'BA',
    municipioIbge: '2927408',
    telefone: '(71) 3333-4444',
  };
  const empresaRes = await api(
    '/api/fiscal/empresa',
    { method: 'PUT', body: JSON.stringify(empresa) },
    admin!,
  );
  check('salva os dados do emitente', empresaRes.status === 200);

  // Antes do emissor, o diagnóstico tem que apontar a falta dele.
  const antes = await unwrap<{
    ready: boolean;
    simulado: boolean;
    checks: { id: string; status: string }[];
  }>(await api('/api/fiscal/readiness', {}, admin!));
  check('diagnóstico reprova sem emissor', !antes.ready && !antes.simulado);
  check(
    'diagnóstico aponta emissor como pendência',
    antes.checks.some((c) => c.id === 'emissor' && c.status === 'fail'),
  );

  // ---------- 2. Certificado ----------
  const invalido = await api(
    '/api/fiscal/certificado',
    {
      method: 'POST',
      body: JSON.stringify({
        pfxBase64: Buffer.from('nao-e-um-pfx').toString('base64'),
        senha: 'x',
      }),
    },
    admin!,
  );
  check('certificado inválido é recusado', invalido.status === 400);

  const pfx = criarPfxTeste('11222333000181');
  const uploadRes = await api(
    '/api/fiscal/certificado',
    { method: 'POST', body: JSON.stringify({ pfxBase64: pfx.base64, senha: pfx.senha }) },
    admin!,
  );
  const uploadBody = (await uploadRes.json()) as ApiRow;
  check(
    'upload de um A1 válido',
    uploadRes.status === 200,
    JSON.stringify(uploadBody).slice(0, 160),
  );
  check(
    'upload lê o titular do certificado',
    uploadBody.data?.certificado?.titular === 'KURUK TESTE',
  );

  const removeRes = await api('/api/fiscal/certificado', { method: 'DELETE' }, admin!);
  check('remove o certificado para testar a geração', removeRes.status === 200);

  let cert: ApiRow | null = null;
  const pfxExterno = process.env.KURUK_TEST_CERT_PFX;
  const senhaExterna = process.env.KURUK_TEST_CERT_PASSWORD;
  if (pfxExterno && senhaExterna) {
    const uploadExterno = await api(
      '/api/fiscal/certificado',
      {
        method: 'POST',
        body: JSON.stringify({
          pfxBase64: fs.readFileSync(pfxExterno).toString('base64'),
          senha: senhaExterna,
        }),
      },
      admin!,
    );
    const bodyExterno = (await uploadExterno.json()) as ApiRow;
    cert = bodyExterno.data?.certificado ?? bodyExterno.certificado ?? null;
    check(
      'usa o certificado de KURUK_TEST_CERT_PFX',
      uploadExterno.status === 200,
      String(uploadExterno.status),
    );
  } else {
    const geradoRes = await api(
      '/api/fiscal/certificado/teste',
      { method: 'POST', body: '{}' },
      admin!,
    );
    const geradoBody = (await geradoRes.json()) as ApiRow;
    cert = geradoBody.data?.certificado ?? geradoBody.certificado ?? null;
    check(
      'gera certificado A1 de teste',
      geradoRes.status === 200,
      JSON.stringify(geradoBody).slice(0, 180),
    );
    check(
      'certificado de teste identifica o titular',
      cert?.titular === 'KURUK TESTE',
      cert?.titular,
    );
    check('certificado de teste traz o CNPJ', cert?.cnpj === '11222333000181', String(cert?.cnpj));
  }
  check('certificado instalado está válido', cert?.expirado === false, String(cert?.validoAte));

  // ---------- 3. Emissor simulado ----------
  const credRes = await api(
    '/api/fiscal/credenciais',
    { method: 'PUT', body: JSON.stringify({ provider: 'simulado', idCsc: '000001' }) },
    admin!,
  );
  check('configura o emissor simulado', credRes.status === 200);

  const pronto = await unwrap<{
    ready: boolean;
    simulado: boolean;
    ambiente: number;
    checks: { id: string; status: string; detail: string }[];
  }>(await api('/api/fiscal/readiness', {}, admin!));
  check('diagnóstico fica pronto no modo simulado', pronto.ready, JSON.stringify(pronto.checks));
  check('diagnóstico marca simulado', pronto.simulado);
  check('ambiente começa em homologação', pronto.ambiente === 2);
  check(
    'CSC é aviso, não bloqueio, no simulado',
    pronto.checks.find((c) => c.id === 'csc')?.status === 'warn',
  );

  // ---------- 4. Produto + estoque + caixa + venda ----------
  const produto = await unwrap<{ id: number }>(
    await api(
      '/api/commercial/products',
      {
        method: 'POST',
        body: JSON.stringify({ name: 'Refrigerante Teste', priceCents: 550, unit: 'un' }),
      },
      admin!,
    ),
  );
  check('cria produto para a venda', !!produto?.id, String(produto?.id));

  const fiscalOk = await api(
    '/api/commercial/products/fiscal',
    {
      method: 'PUT',
      body: JSON.stringify({ ids: [produto.id], patch: { ncm: '2202.10.00', origem: 0 } }),
    },
    admin!,
  );
  check('grava NCM do produto', fiscalOk.status === 200);

  const entrada = await api(
    '/api/commercial/stock/move',
    { method: 'POST', body: JSON.stringify({ productId: produto.id, type: 'entrada', qty: 20 }) },
    admin!,
  );
  check(
    'dá entrada no estoque',
    entrada.status === 201 || entrada.status === 200,
    String(entrada.status),
  );

  const caixa = await api(
    '/api/finance/cash/open',
    { method: 'POST', body: JSON.stringify({ openingCents: 10000 }) },
    admin!,
  );
  check('abre o caixa', caixa.status === 201, String(caixa.status));

  const venda = await unwrap<{ id: number }>(
    await api(
      '/api/store/sales',
      {
        method: 'POST',
        body: JSON.stringify({ items: [{ productId: produto.id, qty: 2 }], paymentMethod: 'pix' }),
      },
      admin!,
    ),
  );
  check('venda criada', !!venda?.id, String(venda?.id));

  const vendasRes = await unwrap<{ id: number }[]>(
    await api('/api/fiscal/documentos/vendas-disponiveis', {}, admin!),
  );
  check(
    'venda aparece como disponível para nota',
    vendasRes.some((v) => v.id === venda.id),
  );

  // ---------- 5. Emissão ----------
  const emissao = await api(
    '/api/fiscal/documentos/emitir',
    { method: 'POST', body: JSON.stringify({ saleId: venda.id }) },
    admin!,
  );
  const emissaoBody = (await emissao.json()) as ApiRow;
  check('emissão responde 201', emissao.status === 201, JSON.stringify(emissaoBody).slice(0, 220));
  const doc = emissaoBody.data;
  check('documento autorizado', doc?.status === 'autorizada', doc?.status);
  check(
    'chave de acesso tem 44 dígitos',
    typeof doc?.key === 'string' && doc.key.length === 44,
    String(doc?.key?.length),
  );
  check(
    'chave começa com UF 29 (BA) e modelo 65',
    doc?.key?.startsWith('29') && doc?.key?.slice(20, 22) === '65',
  );
  check('dígito verificador da chave confere', doc?.key?.[43] === String(digitoChave(doc.key.slice(0, 43))));
  check('cStat 100', doc?.cstat === 100, String(doc?.cstat));
  check(
    'protocolo de 15 dígitos',
    typeof doc?.protocol === 'string' && doc.protocol.length === 15,
    String(doc?.protocol?.length),
  );
  check('documento marcado como teste', doc?.is_test === 1);
  check('provider simulado gravado', doc?.provider === 'simulado', String(doc?.provider));
  check('QR Code gerado', typeof doc?.qr_code === 'string' && doc.qr_code.includes(doc.key));

  const xmlPath = path.join(dataRoot(), String(doc?.xml_path ?? ''));
  check(
    'XML autorizado arquivado',
    !!doc?.xml_path && fs.existsSync(xmlPath),
    String(doc?.xml_path),
  );

  const xmlRes = await api(`/api/fiscal/documentos/${doc.id}/xml`, {}, admin!);
  const xml = await xmlRes.text();
  check('download do XML responde 200', xmlRes.status === 200, String(xmlRes.status));
  check('XML tem NFe e assinatura', xml.includes('<NFe') && xml.includes('<Signature'));
  check('XML tem infNFeSupl/QR Code', xml.includes('<infNFeSupl>') && xml.includes('<qrCode>'));
  check('XML tem protocolo de autorização', xml.includes('<nfeProc') && xml.includes('<nProt>'));
  check('XML está em homologação e leva o NCM do item', xml.includes('<tpAmb>2</tpAmb>') && xml.includes('<NCM>22021000</NCM>'));
  check('XML soma o total da venda', xml.includes('<vNF>11.00</vNF>') && xml.includes('<vProd>11.00</vProd>'));;
  const assinatura = verificarAssinaturaNfe(xml);
  check('digest do infNFe confere', assinatura.digestOk);
  check('assinatura RSA-SHA1 confere', assinatura.signatureOk);

  const cfgDepois = await unwrap<{
    config: { testeOkEm: string };
    readiness: { simulado: boolean };
  }>(await api('/api/fiscal/config', {}, admin!));
  check('teste aprovado destrava a produção', !!cfgDepois.config.testeOkEm);
  check('configuração continua marcada como simulada', cfgDepois.readiness.simulado);

  const vendasDepois = await unwrap<{ id: number }[]>(
    await api('/api/fiscal/documentos/vendas-disponiveis', {}, admin!),
  );
  check('venda emitida sai da lista de disponíveis', !vendasDepois.some((v) => v.id === venda.id));

  const repetida = await api(
    '/api/fiscal/documentos/emitir',
    { method: 'POST', body: JSON.stringify({ saleId: venda.id }) },
    admin!,
  );
  check(
    'não emite duas notas para a mesma venda',
    repetida.status === 400,
    String(repetida.status),
  );

  // ---------- 6. Cancelamento ----------
  const motivo = 'Erro de digitacao no teste do fluxo';
  const cancela = await api(
    `/api/fiscal/documentos/${doc.id}/cancelar`,
    { method: 'POST', body: JSON.stringify({ motivo }) },
    admin!,
  );
  const cancelaBody = (await cancela.json()) as ApiRow;
  check(
    'cancelamento responde 200',
    cancela.status === 200,
    JSON.stringify(cancelaBody).slice(0, 220),
  );
  const cancelado = cancelaBody.data;
  check('nota fica cancelada', cancelado?.status === 'cancelada', cancelado?.status);
  check('evento tem cStat 135', cancelado?.cancel_cstat === 135, String(cancelado?.cancel_cstat));
  check(
    'evento tem protocolo próprio',
    typeof cancelado?.cancel_protocol === 'string' && cancelado.cancel_protocol.length === 15,
  );
  check(
    'XML de cancelamento arquivado',
    !!cancelado?.cancel_xml_path && fs.existsSync(path.join(dataRoot(), cancelado.cancel_xml_path)),
  );

  const cancelXmlRes = await api(
    `/api/fiscal/documentos/${doc.id}/xml?tipo=cancelamento`,
    {},
    admin!,
  );
  const cancelXml = await cancelXmlRes.text();
  check(
    'download do XML de cancelamento',
    cancelXmlRes.status === 200,
    String(cancelXmlRes.status),
  );
  check(
    'evento 110111 no XML',
    cancelXml.includes('procEventoNFe') &&
      cancelXml.includes('110111') &&
      cancelXml.includes(motivo),
  );

  const cancelaVenda = await api(`/api/store/sales/${venda.id}/cancel`, { method: 'POST' }, admin!);
  check(
    'venda pode ser cancelada depois da nota',
    cancelaVenda.status === 200,
    String(cancelaVenda.status),
  );

  // ---------- 7. Rejeição simulada + nova tentativa ----------
  const venda2 = await unwrap<{ id: number }>(
    await api(
      '/api/store/sales',
      {
        method: 'POST',
        body: JSON.stringify({ items: [{ productId: produto.id, qty: 1 }], paymentMethod: 'pix' }),
      },
      admin!,
    ),
  );
  const rejeita = await api(
    '/api/fiscal/documentos/emitir',
    { method: 'POST', body: JSON.stringify({ saleId: venda2.id, simularRejeicao: true }) },
    admin!,
  );
  check('rejeição simulada responde 422', rejeita.status === 422, String(rejeita.status));

  const docsRejeitados = await unwrap<
    { id: number; sale_id: number; status: string; motive: string; number: number }[]
  >(await api('/api/fiscal/documentos', {}, admin!));
  const rejeitado = docsRejeitados.find((d) => d.sale_id === venda2.id && d.status === 'rejeitada');
  check('rejeição fica registrada na lista', !!rejeitado, rejeitado?.motive);

  const retry = await api(
    '/api/fiscal/documentos/emitir',
    { method: 'POST', body: JSON.stringify({ saleId: venda2.id }) },
    admin!,
  );
  const retryBody = (await retry.json()) as ApiRow;
  check(
    'venda rejeitada pode ser emitida de novo',
    retry.status === 201,
    JSON.stringify(retryBody).slice(0, 180),
  );
  check(
    'nova tentativa usa outro número',
    retryBody.data?.number !== rejeitado?.number,
    `${rejeitado?.number} -> ${retryBody.data?.number}`,
  );

  // ---------- 8. Trava de produção ----------
  const prod = await api(
    '/api/fiscal/ambiente',
    { method: 'PUT', body: JSON.stringify({ ambiente: 1 }) },
    admin!,
  );
  check('produção é liberada após teste aprovado', prod.status === 200, String(prod.status));

  const venda3 = await unwrap<{ id: number }>(
    await api(
      '/api/store/sales',
      {
        method: 'POST',
        body: JSON.stringify({ items: [{ productId: produto.id, qty: 1 }], paymentMethod: 'pix' }),
      },
      admin!,
    ),
  );
  const emProd = await api(
    '/api/fiscal/documentos/emitir',
    { method: 'POST', body: JSON.stringify({ saleId: venda3.id }) },
    admin!,
  );
  check('simulado não emite em produção', emProd.status === 400, String(emProd.status));

  const volta = await api(
    '/api/fiscal/ambiente',
    { method: 'PUT', body: JSON.stringify({ ambiente: 2 }) },
    admin!,
  );
  check('volta para homologação', volta.status === 200);

  // ---------- Limpeza ----------
  const xmls = db.prepare('SELECT xml_path, cancel_xml_path FROM fiscal_documents').all() as {
    xml_path: string | null;
    cancel_xml_path: string | null;
  }[];
  for (const row of xmls) {
    for (const relative of [row.xml_path, row.cancel_xml_path]) {
      if (relative) {
        try {
          fs.rmSync(path.join(dataRoot(), relative), { force: true });
        } catch {
          /* arquivo já removido */
        }
      }
    }
  }
  limparCertificadoDeTeste();

  server.close();
  closeDb();
  console.log(
    failures === 0
      ? '\nFiscal (emissão simulada): TODOS OS TESTES PASSARAM'
      : `\n${failures} falha(s)`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
