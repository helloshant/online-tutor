import "server-only";

import crypto from "node:crypto";

function getMerchantId(): string {
  const value = process.env.CCAVENUE_MERCHANT_ID;
  if (!value) throw new Error("Missing CCAVENUE_MERCHANT_ID environment variable");
  return value;
}

function getWorkingKey(): string {
  const value = process.env.CCAVENUE_WORKING_KEY;
  if (!value) throw new Error("Missing CCAVENUE_WORKING_KEY environment variable");
  return value;
}

// access_code is not a secret (it's shipped to the browser as a hidden form
// field alongside the encrypted request, same role Razorpay's key_id
// played) -- merchant_id and working_key never leave the server: merchant_id
// only ever appears inside the encrypted request string, and working_key is
// only ever used here to derive the AES key.
export function getAccessCode(): string {
  const value = process.env.CCAVENUE_ACCESS_CODE;
  if (!value) throw new Error("Missing CCAVENUE_ACCESS_CODE environment variable");
  return value;
}

export function getMerchantIdForRequest(): string {
  return getMerchantId();
}

export function getTransactionUrl(): string {
  const base =
    process.env.CCAVENUE_ENV === "production" ? "https://secure.ccavenue.com" : "https://test.ccavenue.com";
  return `${base}/transaction/transaction.do?command=initiateTransaction`;
}

// CCAvenue's documented encryption scheme (their official integration
// kits, e.g. the Node.js sample code, use this exact key-derivation/IV
// pair): the working key is MD5-hashed to derive a 16-byte AES-128 key, and
// the IV is this fixed 16-byte sequence -- not a security best practice by
// modern standards, but it's CCAvenue's own protocol, not something this app
// gets to choose.
const CCAVENUE_IV = Buffer.from([
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
]);

function deriveKey(workingKey: string): Buffer {
  return crypto.createHash("md5").update(workingKey).digest();
}

export function encrypt(plainText: string): string {
  const key = deriveKey(getWorkingKey());
  const cipher = crypto.createCipheriv("aes-128-cbc", key, CCAVENUE_IV);
  let encrypted = cipher.update(plainText, "utf8", "hex");
  encrypted += cipher.final("hex");
  return encrypted;
}

export function decrypt(encryptedHex: string): string {
  const key = deriveKey(getWorkingKey());
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, CCAVENUE_IV);
  let decrypted = decipher.update(encryptedHex, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}
