/**
 * Montagem do XML da NFC-e (modelo 65, layout 4.00) e assinatura XMLDSig.
 *
 * O emissor simulado usa exatamente o mesmo documento que um emissor real usaria: a
 * diferença está só em quem responde à transmissão. Isso permite testar chave de acesso,
 * itens, impostos, QR Code, assinatura e arquivamento sem depender da SEFAZ.
 *
 * A assinatura é feita com a chave privada do A1 instalado. O documento é montado SEM
 * espaços entre as tags do `infNFe` justamente para que a canonicalização (C14N) do trecho
 * assinado seja previsível. É o mesmo princípio do XMLDSig: o digest cobre o `infNFe`
 * canônico, e o `SignedInfo` é assinado com RSA-SHA1, como no padrão da NF-e.
 */
import crypto from 'node:crypto';
import type { EmpresaFiscal } from './config';
import type { SigningMaterial } from './certificate';

export const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';
export const DSIG_NS = 'http://www.w3.org/2000/09/xmldsig#';

const UF_CODE: Record<string, number> = {
  AC: 12,
  AL: 27,
  AP: 16,
  AM: 13,
  BA: 29,
  CE: 23,
  DF: 53,
  ES: 32,
  GO: 52,
  MA: 21,
  MT: 51,
  MS: 50,
  MG: 31,
  PA: 15,
  PB: 25,
  PR: 41,
  PE: 26,
  PI: 22,
  RJ: 33,
  RN: 24,
  RS: 43,
  RO: 11,
  RR: 14,
  SC: 42,
  SP: 35,
  SE: 28,
  TO: 17,
};

export function onlyDigits(value: unknown): string {
  return String(value ?? '').replace(/\D/g, '');
}

export function ufCode(uf: string): number {
  const code =
    UF_CODE[
      String(uf ?? '')
        .trim()
        .toUpperCase()
    ];
  if (!code) throw new Error(`UF inválida: "${uf || 'vazia'}".`);
  return code;
}

export function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function money(cents: number): string {
  return (Math.round(cents || 0) / 100).toFixed(2);
}

function decimal(value: number, places: number): string {
  return (Number.isFinite(value) ? value : 0).toFixed(places);
}

function truncate(value: unknown, max: number): string {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

/** `YYYY-MM-DDTHH:MM:SS-03:00` no fuso da máquina, como o campo `dhEmi` exige. */
export function localDateTimeWithOffset(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** Dígito verificador da chave de acesso (módulo 11, pesos 2 a 9 da direita para a esquerda). */
function accessKeyDigit(base43: string): number {
  let weight = 2;
  let sum = 0;
  for (let i = base43.length - 1; i >= 0; i--) {
    sum += Number(base43[i]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

export interface AccessKeyInput {
  cUF: number;
  cnpj: string;
  model: string;
  serie: number;
  number: number;
  tpEmis: number;
  cNF: string;
  environment: 1 | 2;
  date?: Date;
}

/**
 * Chave de 44 dígitos: UF + AAMM + CNPJ + modelo + série + número + tpEmis + cNF + DV.
 * Produção e homologação têm ambientes diferentes, mas a chave NÃO carrega o ambiente —
 * quem separa as numerações é a tabela `fiscal_sequences`.
 */
export function buildAccessKey(input: AccessKeyInput): string {
  const date = input.date ?? new Date();
  const cnpj = onlyDigits(input.cnpj);
  if (cnpj.length !== 14) throw new Error('CNPJ do emitente inválido para a chave de acesso.');
  if (input.serie < 1 || input.serie > 999)
    throw new Error('Série inválida para a chave de acesso.');
  if (input.number < 1 || input.number > 999_999_999)
    throw new Error('Número da nota inválido para a chave de acesso.');
  const aamm = `${String(date.getFullYear()).slice(-2)}${String(date.getMonth() + 1).padStart(2, '0')}`;
  const base =
    `${String(input.cUF).padStart(2, '0')}` +
    aamm +
    cnpj +
    input.model +
    String(input.serie).padStart(3, '0') +
    String(input.number).padStart(9, '0') +
    String(input.tpEmis) +
    input.cNF.padStart(8, '0').slice(-8);
  return `${base}${accessKeyDigit(base)}`;
}

export interface QrCodeInput {
  key: string;
  environment: 1 | 2;
  idCsc: string;
  csc: string;
}

/**
 * QR Code da NFC-e. A URL aponta para um endereço de simulação: a consulta real é do
 * domínio da SEFAZ de cada UF, e este emissor não transmite nada.
 */
export function buildQrCode(input: QrCodeInput): { qrCode: string; urlChave: string } {
  const version = '2';
  const idCsc = input.idCsc || '000001';
  const hash = crypto
    .createHash('sha1')
    .update(`${input.key}|${version}|${input.environment}|${idCsc}${input.csc}`)
    .digest('hex')
    .toUpperCase();
  const base =
    input.environment === 2
      ? 'https://nfce.simulado.kuruk.local/homologacao'
      : 'https://nfce.simulado.kuruk.local/producao';
  return {
    qrCode: `${base}?p=${input.key}|${version}|${input.environment}|${idCsc}|${hash}`,
    urlChave: base,
  };
}

export interface NfceItemInput {
  productId: number;
  name: string;
  sku: string | null;
  barcode: string | null;
  ncm: string;
  cest: string | null;
  cfop: string;
  unit: string;
  unitFiscal: string | null;
  qty: number;
  totalCents: number;
  csosn: string | null;
  cst: string | null;
  origem: number | null;
}

export interface NfceBuildInput {
  key: string;
  environment: 1 | 2;
  serie: number;
  number: number;
  emittedAt: Date;
  emitente: EmpresaFiscal;
  crt: 1 | 2 | 3;
  cfop: string;
  csosnPadrao: string;
  cstPadrao: string;
  origemPadrao: number;
  subtotalCents: number;
  discountCents: number;
  surchargeCents: number;
  totalCents: number;
  paymentCode: string;
  items: NfceItemInput[];
  customer: { name: string; document: string | null } | null;
  qrCode: string;
  urlChave: string;
  isTest: boolean;
  saleId: number;
}

/** GTIN só entra quando tem um dos tamanhos aceitos; qualquer outra coisa vira SEM GTIN. */
function gtinOrSem(value: unknown): string {
  const digits = onlyDigits(value);
  return [8, 12, 13, 14].includes(digits.length) ? digits : 'SEM GTIN';
}

function fiscalUnit(item: NfceItemInput): string {
  const unit = truncate(item.unitFiscal || item.unit || 'UN', 6).toUpperCase();
  const aliases: Record<string, string> = {
    UNID: 'UN',
    UNIDADE: 'UN',
    UND: 'UN',
    UNI: 'UN',
    PC: 'PC',
    PECA: 'PC',
    PEÇA: 'PC',
    CX: 'CX',
    CAIXA: 'CX',
    KG: 'KG',
    QUILO: 'KG',
    LT: 'L',
    LITRO: 'L',
  };
  return aliases[unit] ?? unit;
}

function icmsGroup(item: NfceItemInput, input: NfceBuildInput): string {
  const origem = item.origem ?? input.origemPadrao;
  if (input.crt === 3) {
    const cst = item.cst || input.cstPadrao || '00';
    if (cst === '00') {
      return (
        '<ICMS><ICMS00>' +
        `<orig>${origem}</orig><CST>00</CST><modBC>3</modBC>` +
        `<vBC>${money(item.totalCents)}</vBC><pICMS>0.00</pICMS><vICMS>0.00</vICMS>` +
        '</ICMS00></ICMS>'
      );
    }
    if (cst === '40' || cst === '41') {
      return `<ICMS><ICMS40><orig>${origem}</orig><CST>${cst}</CST></ICMS40></ICMS>`;
    }
    if (cst === '60') {
      return (
        '<ICMS><ICMS60>' +
        `<orig>${origem}</orig><CST>60</CST><vBCSTRet>0.00</vBCSTRet><vICMSSTRet>0.00</vICMSSTRet>` +
        '</ICMS60></ICMS>'
      );
    }
    throw new Error(`CST ${cst} ainda não suportado pelo emissor simulado. Use 00, 40, 41 ou 60.`);
  }

  const csosn = item.csosn || input.csosnPadrao || '102';
  switch (csosn) {
    case '101':
      return (
        '<ICMS><ICMSSN101>' +
        `<orig>${origem}</orig><CSOSN>101</CSOSN><pCredSN>0.00</pCredSN><vCredICMSSN>0.00</vCredICMSSN>` +
        '</ICMSSN101></ICMS>'
      );
    case '102':
    case '103':
    case '300':
    case '400':
      return `<ICMS><ICMSSN102><orig>${origem}</orig><CSOSN>${csosn}</CSOSN></ICMSSN102></ICMS>`;
    case '201':
    case '202':
      return (
        `<ICMS><ICMSSN${csosn}>` +
        `<orig>${origem}</orig><CSOSN>${csosn}</CSOSN>` +
        '<modBCST>4</modBCST><pMVAST>0.00</pMVAST><pRedBCST>0.00</pRedBCST>' +
        '<vBCST>0.00</vBCST><pICMSST>0.00</pICMSST><vICMSST>0.00</vICMSST>' +
        `</ICMSSN${csosn}></ICMS>`
      );
    case '500':
      return (
        '<ICMS><ICMSSN500>' +
        `<orig>${origem}</orig><CSOSN>500</CSOSN>` +
        '<vBCSTRet>0.00</vBCSTRet><pST>0.00</pST><vICMSSubstituto>0.00</vICMSSubstituto>' +
        '<vICMSSTRet>0.00</vICMSSTRet>' +
        '</ICMSSN500></ICMS>'
      );
    case '900':
      return (
        '<ICMS><ICMSSN900>' +
        `<orig>${origem}</orig><CSOSN>900</CSOSN>` +
        '<modBC>3</modBC><vBC>0.00</vBC><pRedBC>0.00</pRedBC><pICMS>0.00</pICMS><vICMS>0.00</vICMS>' +
        '<modBCST>4</modBCST><pMVAST>0.00</pMVAST><pRedBCST>0.00</pRedBCST>' +
        '<vBCST>0.00</vBCST><pICMSST>0.00</pICMSST><vICMSST>0.00</vICMSST>' +
        '</ICMSSN900></ICMS>'
      );
    default:
      throw new Error(
        `CSOSN ${csosn} ainda não suportado pelo emissor simulado. Use 101, 102, 103, 201, 202, 300, 400, 500 ou 900.`,
      );
  }
}

function buildDet(item: NfceItemInput, nItem: number, input: NfceBuildInput): string {
  const unit = fiscalUnit(item);
  const qty = decimal(item.qty, 4);
  const unitValue = decimal(item.totalCents / 100 / (item.qty || 1), 4);
  const ncm = onlyDigits(item.ncm);
  if (ncm.length !== 8) throw new Error(`NCM inválido no produto "${item.name}".`);
  const cfop = onlyDigits(item.cfop || input.cfop)
    .padStart(4, '0')
    .slice(-4);
  const cEan = gtinOrSem(item.barcode);
  const cest = item.cest ? onlyDigits(item.cest) : '';

  return (
    `<det nItem="${nItem}">` +
    '<prod>' +
    `<cProd>${escapeXml(item.sku || item.productId)}</cProd>` +
    `<cEAN>${cEan}</cEAN>` +
    `<xProd>${escapeXml(truncate(item.name, 120))}</xProd>` +
    `<NCM>${ncm}</NCM>` +
    (cest ? `<CEST>${cest}</CEST>` : '') +
    `<CFOP>${cfop}</CFOP>` +
    `<uCom>${escapeXml(unit)}</uCom>` +
    `<qCom>${qty}</qCom>` +
    `<vUnCom>${unitValue}</vUnCom>` +
    `<vProd>${money(item.totalCents)}</vProd>` +
    `<cEANTrib>${cEan}</cEANTrib>` +
    `<uTrib>${escapeXml(unit)}</uTrib>` +
    `<qTrib>${qty}</qTrib>` +
    `<vUnTrib>${unitValue}</vUnTrib>` +
    '<indTot>1</indTot>' +
    '</prod>' +
    '<imposto>' +
    icmsGroup(item, input) +
    '<PIS><PISNT><CST>07</CST></PISNT></PIS>' +
    '<COFINS><COFINSNT><CST>07</CST></COFINSNT></COFINS>' +
    '</imposto>' +
    '</det>'
  );
}

function buildDest(input: NfceBuildInput): string {
  const document = onlyDigits(input.customer?.document);
  if (!input.customer || (document.length !== 11 && document.length !== 14)) return '';
  const docTag = document.length === 11 ? 'CPF' : 'CNPJ';
  return (
    '<dest>' +
    `<${docTag}>${document}</${docTag}>` +
    `<xNome>${escapeXml(truncate(input.customer.name || 'CONSUMIDOR FINAL', 60))}</xNome>` +
    '<indIEDest>9</indIEDest>' +
    '</dest>'
  );
}

function signedInfoXml(referenceId: string, digestValue: string): string {
  return (
    `<SignedInfo xmlns="${DSIG_NS}">` +
    '<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>' +
    '<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/>' +
    `<Reference URI="#${referenceId}">` +
    '<Transforms>' +
    '<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>' +
    '<Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>' +
    '</Transforms>' +
    '<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>' +
    `<DigestValue>${digestValue}</DigestValue>` +
    '</Reference>' +
    '</SignedInfo>'
  );
}

function signatureXml(
  signedInfo: string,
  signatureValue: string,
  material: SigningMaterial,
): string {
  return (
    `<Signature xmlns="${DSIG_NS}">` +
    signedInfo +
    `<SignatureValue>${signatureValue}</SignatureValue>` +
    '<KeyInfo><X509Data>' +
    `<X509Certificate>${material.certificateBase64}</X509Certificate>` +
    '</X509Data></KeyInfo>' +
    '</Signature>'
  );
}

function signSha1(payload: string, privateKeyPem: string): string {
  return crypto.createSign('RSA-SHA1').update(payload, 'utf8').sign(privateKeyPem, 'base64');
}

export interface BuiltNfe {
  xml: string;
  digestValue: string;
  signatureValue: string;
}

export function buildNfceXml(input: NfceBuildInput, material: SigningMaterial): BuiltNfe {
  const empresa = input.emitente;
  const cnpj = onlyDigits(empresa.cnpj);
  if (cnpj.length !== 14) throw new Error('CNPJ do emitente inválido.');
  const cUF = ufCode(empresa.uf);
  const cMun = onlyDigits(empresa.municipioIbge);
  if (cMun.length !== 7) throw new Error('Código IBGE do município do emitente inválido.');
  const cnpjEmit = cnpj;
  const cNF = input.key.slice(35, 43);
  const cDV = input.key.slice(43);

  const det = input.items.map((item, index) => buildDet(item, index + 1, input)).join('');
  const vProd = money(input.subtotalCents);
  const vDesc = money(input.discountCents);
  const vOutro = money(input.surchargeCents);
  const vNF = money(input.totalCents);
  const endereco =
    '<enderEmit>' +
    `<xLgr>${escapeXml(truncate(empresa.rua, 60))}</xLgr>` +
    `<nro>${escapeXml(truncate(empresa.numero, 60))}</nro>` +
    (empresa.complemento ? `<xCpl>${escapeXml(truncate(empresa.complemento, 60))}</xCpl>` : '') +
    `<xBairro>${escapeXml(truncate(empresa.bairro, 60))}</xBairro>` +
    `<cMun>${cMun}</cMun>` +
    `<xMun>${escapeXml(truncate(empresa.cidade, 60))}</xMun>` +
    `<UF>${escapeXml(empresa.uf)}</UF>` +
    `<CEP>${onlyDigits(empresa.cep)}</CEP>` +
    '<cPais>1058</cPais><xPais>BRASIL</xPais>' +
    (empresa.telefone ? `<fone>${onlyDigits(empresa.telefone)}</fone>` : '') +
    '</enderEmit>';

  const infNFeInner =
    '<ide>' +
    `<cUF>${cUF}</cUF>` +
    `<cNF>${cNF}</cNF>` +
    '<natOp>VENDA DE MERCADORIA</natOp>' +
    '<mod>65</mod>' +
    `<serie>${input.serie}</serie>` +
    `<nNF>${input.number}</nNF>` +
    `<dhEmi>${localDateTimeWithOffset(input.emittedAt)}</dhEmi>` +
    '<tpNF>1</tpNF>' +
    '<idDest>1</idDest>' +
    `<cMunFG>${cMun}</cMunFG>` +
    '<tpImp>4</tpImp>' +
    '<tpEmis>1</tpEmis>' +
    `<cDV>${cDV}</cDV>` +
    `<tpAmb>${input.environment}</tpAmb>` +
    '<finNFe>1</finNFe>' +
    '<indFinal>1</indFinal>' +
    '<indPres>1</indPres>' +
    '<procEmi>0</procEmi>' +
    '<verProc>Kuruk 2.1</verProc>' +
    '</ide>' +
    '<emit>' +
    `<CNPJ>${cnpjEmit}</CNPJ>` +
    `<xNome>${escapeXml(truncate(empresa.razaoSocial, 60))}</xNome>` +
    (empresa.nomeFantasia
      ? `<xFant>${escapeXml(truncate(empresa.nomeFantasia, 60))}</xFant>`
      : '') +
    endereco +
    `<IE>${escapeXml(empresa.ie)}</IE>` +
    `<CRT>${input.crt}</CRT>` +
    '</emit>' +
    buildDest(input) +
    det +
    '<total><ICMSTot>' +
    '<vBC>0.00</vBC><vICMS>0.00</vICMS><vICMSDeson>0.00</vICMSDeson>' +
    '<vFCPUFDest>0.00</vFCPUFDest><vICMSUFDest>0.00</vICMSUFDest><vICMSUFRemet>0.00</vICMSUFRemet>' +
    '<vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet>' +
    `<vProd>${vProd}</vProd><vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>${vDesc}</vDesc>` +
    '<vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol><vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS>' +
    `<vOutro>${vOutro}</vOutro><vNF>${vNF}</vNF>` +
    '</ICMSTot></total>' +
    '<transp><modFrete>9</modFrete></transp>' +
    '<pag><detPag>' +
    `<tPag>${input.paymentCode}</tPag>` +
    (input.paymentCode === '99' ? '<xPag>Outros</xPag>' : '') +
    `<vPag>${vNF}</vPag>` +
    '</detPag></pag>' +
    '<infAdic><infCpl>' +
    escapeXml(
      `Venda #${input.saleId} - Emitido por Kuruk` +
        (input.isTest ? ' - HOMOLOGACAO SIMULADA - SEM VALOR FISCAL' : ''),
    ) +
    '</infCpl></infAdic>';

  const infNFe = `<infNFe Id="NFe${input.key}" versao="4.00">${infNFeInner}</infNFe>`;
  const canonicalInfNFe = `<infNFe xmlns="${NFE_NS}" Id="NFe${input.key}" versao="4.00">${infNFeInner}</infNFe>`;
  const digestValue = crypto.createHash('sha1').update(canonicalInfNFe, 'utf8').digest('base64');
  const signedInfo = signedInfoXml(`NFe${input.key}`, digestValue);
  const signatureValue = signSha1(signedInfo, material.privateKeyPem);
  const infNFeSupl =
    '<infNFeSupl>' +
    `<qrCode><![CDATA[${input.qrCode}]]></qrCode>` +
    `<urlChave>${escapeXml(input.urlChave)}</urlChave>` +
    '</infNFeSupl>';
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<NFe xmlns="${NFE_NS}">${infNFe}${infNFeSupl}${signatureXml(signedInfo, signatureValue, material)}</NFe>`;

  return { xml, digestValue, signatureValue };
}

export interface AuthorizationResponse {
  key: string;
  environment: 1 | 2;
  cStat: number;
  xMotivo: string;
  protocol: string | null;
  dhRecbto: string | null;
  digVal: string | null;
}

/** Envelope de distribuição: `<nfeProc>` com a NFe assinada + protocolo de autorização. */
export function buildProcNfe(nfeXml: string, auth: AuthorizationResponse): string {
  const declaration = '<?xml version="1.0" encoding="UTF-8"?>';
  const body = nfeXml.replace(/^<\?xml[^>]*\?>\s*/, '');
  const prot =
    '<protNFe versao="4.00"><infProt>' +
    `<tpAmb>${auth.environment}</tpAmb>` +
    '<verAplic>KURUK-SIMULADO-1.0</verAplic>' +
    `<chNFe>${auth.key}</chNFe>` +
    `<dhRecbto>${auth.dhRecbto ?? ''}</dhRecbto>` +
    (auth.protocol ? `<nProt>${auth.protocol}</nProt>` : '') +
    (auth.digVal ? `<digVal>${auth.digVal}</digVal>` : '') +
    `<cStat>${auth.cStat}</cStat>` +
    `<xMotivo>${escapeXml(auth.xMotivo)}</xMotivo>` +
    '</infProt></protNFe>';
  return `${declaration}<nfeProc xmlns="${NFE_NS}" versao="4.00">${body}${prot}</nfeProc>`;
}

export interface CancellationResponse {
  cStat: number;
  xMotivo: string;
  protocol: string;
  dhRegEvento: string;
}

export interface CancellationInput {
  key: string;
  environment: 1 | 2;
  cnpj: string;
  cUF: number;
  authorizationProtocol: string;
  reason: string;
  occurredAt: Date;
  response: CancellationResponse;
}

/** Evento de cancelamento (tpEvento 110111) assinado + retorno 135 do simulador. */
export function buildCancellationEventXml(
  input: CancellationInput,
  material: SigningMaterial,
): BuiltNfe {
  const infEventoInner =
    `<cOrgao>${input.cUF}</cOrgao>` +
    `<tpAmb>${input.environment}</tpAmb>` +
    `<CNPJ>${onlyDigits(input.cnpj)}</CNPJ>` +
    `<chNFe>${input.key}</chNFe>` +
    `<dhEvento>${localDateTimeWithOffset(input.occurredAt)}</dhEvento>` +
    '<tpEvento>110111</tpEvento>' +
    '<nSeqEvento>1</nSeqEvento>' +
    '<verEvento>1.00</verEvento>' +
    '<detEvento versao="1.00">' +
    '<descEvento>Cancelamento</descEvento>' +
    `<nProt>${escapeXml(input.authorizationProtocol)}</nProt>` +
    `<xJust>${escapeXml(truncate(input.reason, 255))}</xJust>` +
    '</detEvento>';

  const eventId = `ID110111${input.key}01`;
  const infEvento = `<infEvento Id="${eventId}">${infEventoInner}</infEvento>`;
  const canonicalInfEvento = `<infEvento xmlns="${NFE_NS}" Id="${eventId}">${infEventoInner}</infEvento>`;
  const digestValue = crypto.createHash('sha1').update(canonicalInfEvento, 'utf8').digest('base64');
  const signedInfo = signedInfoXml(eventId, digestValue);
  const signatureValue = signSha1(signedInfo, material.privateKeyPem);

  const evento =
    `<evento xmlns="${NFE_NS}" versao="1.00">` +
    infEvento +
    signatureXml(signedInfo, signatureValue, material) +
    '</evento>';

  const retEvento =
    '<retEvento versao="1.00"><infEvento>' +
    `<tpAmb>${input.environment}</tpAmb>` +
    '<verAplic>KURUK-SIMULADO-1.0</verAplic>' +
    `<cOrgao>${input.cUF}</cOrgao>` +
    `<cStat>${input.response.cStat}</cStat>` +
    `<xMotivo>${escapeXml(input.response.xMotivo)}</xMotivo>` +
    `<chNFe>${input.key}</chNFe>` +
    '<tpEvento>110111</tpEvento>' +
    '<nSeqEvento>1</nSeqEvento>' +
    `<dhRegEvento>${input.response.dhRegEvento}</dhRegEvento>` +
    `<nProt>${input.response.protocol}</nProt>` +
    '</infEvento></retEvento>';

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<procEventoNFe xmlns="${NFE_NS}" versao="1.00">${evento}${retEvento}</procEventoNFe>`;

  return { xml, digestValue, signatureValue };
}
