import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";

const FOUR_DIGIT_PIN = /^\\d{4}$/;

export function generateReceiverPin(): string {
  return String(randomInt(0, 10000)).padStart(4, "0");
}

export function hashPin(pin: string): string {
  if (!FOUR_DIGIT_PIN.test(pin)) throw new Error("Receiver PIN must be exactly four digits");
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(pin, salt, 32).toString("hex");
  return salt + ":" + derived;
}

export function verifyPin(pin: string, stored: string): boolean {
  if (!FOUR_DIGIT_PIN.test(pin)) return false;
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const actual = scryptSync(pin, salt, 32);
  const expectedBuffer = Buffer.from(expected, "hex");
  return expectedBuffer.length === actual.length && timingSafeEqual(actual, expectedBuffer);
}


export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return salt + ":" + derived;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, "hex");
  return expectedBuffer.length === actual.length && timingSafeEqual(actual, expectedBuffer);
}
