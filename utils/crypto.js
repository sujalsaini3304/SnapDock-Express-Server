//Generate key from this ---------- 
// node -e "console.log(require('crypto').createHash('sha256').update('YOUR_SECRET_KEY').digest('hex'))"

import crypto from "crypto";

const SECRET_KEY = Buffer.from(process.env.AES_SECRET_KEY, "hex");
const IV_LENGTH = 12; // GCM uses 12 bytes (NOT 16)


// Encryption
export function encrypt(text) {
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    SECRET_KEY,
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  // Return iv + ciphertext + authTag
  return (
    iv.toString("hex") +
    ":" +
    encrypted.toString("hex") +
    ":" +
    authTag.toString("hex")
  );
}



// Decryption
export function decrypt(data) {
  const [ivHex, encryptedHex, authTagHex] = data.split(":");

  const iv = Buffer.from(ivHex, "hex");
  const encryptedText = Buffer.from(encryptedHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    SECRET_KEY,
    iv
  );

  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encryptedText),
    decipher.final(),
  ]);

  return decrypted.toString();
}


