/**
 * Emissor simulado (homologação local).
 *
 * Não fala com a SEFAZ e não tem valor fiscal. Existe para exercitar o fluxo de ponta a
 * ponta — assinatura, chave, protocolo, XML autorizado, QR Code e cancelamento — enquanto
 * a integração com um emissor real não existe. O nome "simulado" é gravado em
 * `fiscal_documents.provider`, então o que foi gerado por ele nunca se confunde com uma
 * nota de produção.
 */
import { randomInt } from 'node:crypto';

export interface SimulatedAuthorization {
  status: 'autorizada' | 'rejeitada';
  cStat: number;
  xMotivo: string;
  protocol: string | null;
  dhRecbto: string | null;
  digVal: string | null;
}

/** Data/hora no formato do SQLite (UTC, sem fuso), como as outras colunas do banco. */
function sqlUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/** Protocolo de 15 dígitos, no formato do retorno da SEFAZ. */
export function simulatedProtocol(): string {
  return `${Date.now()}${String(randomInt(0, 100)).padStart(2, '0')}`.slice(-15);
}

export interface AuthorizeInput {
  key: string;
  environment: 1 | 2;
  digestValue: string;
  /** Botão de teste: força uma rejeição para conferir o caminho de erro. */
  forceReject?: boolean;
}

export function authorizeSimulated(input: AuthorizeInput): SimulatedAuthorization {
  if (input.forceReject) {
    return {
      status: 'rejeitada',
      cStat: 999,
      xMotivo: 'Rejeição simulada para teste do fluxo.',
      protocol: null,
      dhRecbto: null,
      digVal: null,
    };
  }

  return {
    status: 'autorizada',
    cStat: 100,
    xMotivo: 'Autorizado o uso da NF-e',
    protocol: simulatedProtocol(),
    dhRecbto: sqlUtc(new Date()),
    digVal: input.digestValue,
  };
}

export interface SimulatedCancellation {
  cStat: number;
  xMotivo: string;
  protocol: string;
  dhRegEvento: string;
}

export function cancelSimulated(): SimulatedCancellation {
  return {
    cStat: 135,
    xMotivo: 'Evento registrado e vinculado a NF-e',
    protocol: simulatedProtocol(),
    dhRegEvento: sqlUtc(new Date()),
  };
}
