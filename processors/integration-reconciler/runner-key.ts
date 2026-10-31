/**
 * This environment's runner key: the key the reconciler signs publishes with
 * for a person who granted it (ADR 0008). Never the host's key, which means "no
 * user" to the workflow runtime and signs for unsigned callers too.
 *
 * It lives beside the host key under the user's .ph folder, so it survives a
 * restart. Where PH_WORKFLOWS_SECRETS_MASTER_KEY is set the file is encrypted
 * under it: piece workers run with no env, so they can read the file but not
 * open it. On a person's own computer there is no such key, and the file is
 * plain, on the same disk as the host key (ADR 0008 §12).
 */
import type { IRenownCrypto, JsonWebKeyPairStorage, JwkKeyPair } from "@renown/sdk/node";
import { RenownCryptoBuilder } from "@renown/sdk/node";
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const MASTER_KEY_ENV = "PH_WORKFLOWS_SECRETS_MASTER_KEY";
const FILE_NAME = ".runner-keypair.json";
const KEY_LABEL = "sektar/runner-key/v1";

type Env = Readonly<Record<string, string | undefined>>;

type Sealed = { v: 1; iv: string; tag: string; data: string };
type StoredFile = { keyPair: JwkKeyPair } | Sealed;

/** Where the key lives: the same `.ph` folder the host key is in. */
export function runnerKeyPath(env: Env = process.env): string {
  return join(env.PH_USER_DATA_DIR ?? process.cwd(), ".ph", FILE_NAME);
}

function sealingKey(masterKeyHex: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(masterKeyHex, "hex"),
      Buffer.alloc(0),
      KEY_LABEL,
      32,
    ),
  );
}

function seal(keyPair: JwkKeyPair, masterKeyHex: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealingKey(masterKeyHex), iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(keyPair), "utf8"),
    cipher.final(),
  ]);
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function open(sealed: Sealed, masterKeyHex: string): JwkKeyPair {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    sealingKey(masterKeyHex),
    Buffer.from(sealed.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  const text = Buffer.concat([
    decipher.update(Buffer.from(sealed.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(text) as JwkKeyPair;
}

/** Key pair storage for the runner key, sealed when a master key is given. */
export class RunnerKeyStorage implements JsonWebKeyPairStorage {
  constructor(
    private readonly filePath: string,
    private readonly masterKeyHex?: string,
  ) {}

  loadKeyPair(): Promise<JwkKeyPair | undefined> {
    let text: string;
    try {
      text = readFileSync(this.filePath, "utf8");
    } catch {
      return Promise.resolve(undefined);
    }
    const stored = JSON.parse(text) as StoredFile;
    if ("keyPair" in stored) return Promise.resolve(stored.keyPair);
    if (!this.masterKeyHex) {
      throw new Error(
        `${this.filePath} is encrypted, and ${MASTER_KEY_ENV} is not set`,
      );
    }
    return Promise.resolve(open(stored, this.masterKeyHex));
  }

  saveKeyPair(keyPair: JwkKeyPair): Promise<void> {
    const stored: StoredFile = this.masterKeyHex
      ? seal(keyPair, this.masterKeyHex)
      : { keyPair };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const partial = `${this.filePath}.tmp`;
    writeFileSync(partial, JSON.stringify(stored), { mode: 0o600 });
    renameSync(partial, this.filePath);
    return Promise.resolve();
  }

  removeKeyPair(): Promise<void> {
    rmSync(this.filePath, { force: true });
    return Promise.resolve();
  }
}

/** Loads this environment's runner key, making it on first use. */
export function loadRunnerKey(env: Env = process.env): Promise<IRenownCrypto> {
  return new RenownCryptoBuilder()
    .withKeyPairStorage(
      new RunnerKeyStorage(runnerKeyPath(env), env[MASTER_KEY_ENV]),
    )
    .build();
}
