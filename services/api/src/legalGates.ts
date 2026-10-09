export type LegalGate =
  | "STATION_AGENT_LIABILITY"
  | "LICENSED_ESCROW_PARTNER"
  | "NIPOST_COURIER"
  | "NHIA_COURIER"
  | "NDPC_PRIVACY"
  | "COURIER_LIABILITY"
  | "RECEIVER_PAYS_TERMS";

const envName = (gate: LegalGate): string => "SWIFTDROP_LEGAL_GATE_" + gate;

export function legalGateEnabled(gate: LegalGate): boolean {
  return process.env[envName(gate)] === "true";
}

export function assertLegalGateEnabled(gate: LegalGate): void {
  if (!legalGateEnabled(gate)) throw new Error("Legal gate " + gate + " is not enabled");
}
