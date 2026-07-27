import { describe, expect, it } from "vitest";
import { blake3 } from "@noble/hashes/blake3.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  ADDRESS_DERIVATION_DOMAIN,
  ENUM_VARIANT_INDEX_ML_DSA_65,
  ML_DSA_65_PUBLIC_KEY_LEN,
  ML_DSA_65_SEED_LEN,
  ML_DSA_65_SIGNATURE_LEN,
  MlDsa65Backend,
  STANDARD_ALGO_NUMBER_ML_DSA_65,
  bytesToHex,
  bincodeSignedTransaction,
  concatBytes,
  encodeTransactionForHash,
  mlDsa65AddressFromPublicKey,
} from "../src/crypto/index.js";

describe("crypto subpath", () => {
  const MRV_NATIVE_TX_VECTOR = {
    fields: {
      chainId: 69_420n,
      nonce: 7n,
      maxPriorityFeePerGas: 1n,
      maxFeePerGas: 25n,
      gasLimit: 100_000n,
      to: null,
      value: 0n,
      input: "0x13000000",
      extensions: [{ kind: 0x30, bodyHex: "0x01" }],
    },
    signingPreimage:
      "0x010000000000010f2c00000000000000070000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000001900000000000186a000000000000000000000000000000000000000000000000000000000000000000000000004130000000000000000000001300000000101",
    sighash: "0xb680eb3b3e67b441d22c4ac441c9355809cac860dc2c0773ed47e49f273725c3",
    identityTxHash: "0x0f826159573ebe870876d03e9b54541fbbb652de4642552abc9a65a481781789",
    wireLen: 5_472,
    wirePrefix:
      "0x2c0f01000000000007000000000000002000000000000000000000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000000000000000000000019a0860100000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000040000000000000013000000000000",
    wireSuffix:
      "0x6666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666",
  } as const;

  it("derives deterministic ML-DSA-65 keys and signatures from a seed", () => {
    const seed = new Uint8Array(ML_DSA_65_SEED_LEN).fill(0x42);
    const a = MlDsa65Backend.fromSeed(seed);
    const b = MlDsa65Backend.fromSeed(seed);
    expect(a.publicKey()).toHaveLength(ML_DSA_65_PUBLIC_KEY_LEN);
    expect(a.getAddress()).toBe(b.getAddress());
    expect(bytesToHex(a.publicKey())).toBe(bytesToHex(b.publicKey()));
    expect(mlDsa65AddressFromPublicKey(a.publicKey())).toBe(a.getAddress());

    const derivationPreimage = concatBytes(
      new TextEncoder().encode(ADDRESS_DERIVATION_DOMAIN),
      new Uint8Array([
        STANDARD_ALGO_NUMBER_ML_DSA_65 >> 8,
        STANDARD_ALGO_NUMBER_ML_DSA_65 & 0xff,
      ]),
      a.publicKey(),
    );
    expect(a.getAddress()).toBe(bytesToHex(blake3(derivationPreimage).slice(0, 20)));
    expect(a.getAddress()).not.toBe(bytesToHex(keccak_256(a.publicKey()).slice(12)));

    const msg = new Uint8Array([1, 2, 3]);
    const sigA = a.sign(msg);
    const sigB = b.sign(msg);
    expect(sigA).toHaveLength(ML_DSA_65_SIGNATURE_LEN);
    expect(bytesToHex(sigA)).toBe(bytesToHex(sigB));
    expect(a.verify(msg, sigA)).toBe(true);
    expect(a.verify(new Uint8Array([1, 2, 4]), sigA)).toBe(false);
  });

  it("dispose() wipes the secret key and makes signing throw (S1-01)", () => {
    const seed = new Uint8Array(ML_DSA_65_SEED_LEN).fill(0x42);
    const a = MlDsa65Backend.fromSeed(seed);
    const msg = new Uint8Array([1, 2, 3]);
    const sig = a.sign(msg);
    expect(a.verify(msg, sig)).toBe(true);
    expect(a.disposed).toBe(false);

    a.dispose();
    expect(a.disposed).toBe(true);
    // Signing throws after dispose instead of signing with a zeroed key.
    expect(() => a.sign(msg)).toThrow("MlDsa65Backend disposed");
    expect(() => a.signPrehash(new Uint8Array(32))).toThrow("MlDsa65Backend disposed");
    // Idempotent; zeroize() is an alias.
    expect(() => a.dispose()).not.toThrow();
    expect(() => a.zeroize()).not.toThrow();
    expect(a.disposed).toBe(true);
    // Public material stays usable and still matches a fresh derivation.
    expect(a.getAddress()).toBe(MlDsa65Backend.fromSeed(seed).getAddress());
    expect(a.verify(msg, sig)).toBe(true);
  });

  it("encodes native tx hash preimages with signed-over field changes", () => {
    const base = {
      chainId: 69420n,
      nonce: 7n,
      maxPriorityFeePerGas: 1n,
      maxFeePerGas: 2n,
      gasLimit: 30_000n,
      to: `0x${"11".repeat(20)}`,
      value: 3n,
      input: "0x",
    };
    const a = encodeTransactionForHash(base, 0x01);
    const b = encodeTransactionForHash({ ...base, nonce: 8n }, 0x01);
    const c = encodeTransactionForHash(base, 0x02);
    expect(a[0]).toBe(0x01);
    expect(c[0]).toBe(0x02);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
    expect(bytesToHex(a)).not.toBe(bytesToHex(c));
  });

  it("signs over typed native tx extensions and serializes them in bincode wire bytes", () => {
    const base = {
      chainId: 69420n,
      nonce: 7n,
      maxPriorityFeePerGas: 1n,
      maxFeePerGas: 2n,
      gasLimit: 30_000n,
      to: null,
      value: 3n,
      input: "0x13000000",
    };
    const noExtension = encodeTransactionForHash(base, 0x01);
    const withMrvExtension = encodeTransactionForHash(
      { ...base, extensions: [{ kind: 0x30, bodyHex: "0x01" }] },
      0x01,
    );

    expect(bytesToHex(noExtension).endsWith("0000000000000000")).toBe(true);
    expect(bytesToHex(withMrvExtension).endsWith("0000000000000001300000000101")).toBe(true);
    expect(bytesToHex(withMrvExtension)).not.toBe(bytesToHex(noExtension));

    const wire = bincodeSignedTransaction(
      { ...base, extensions: [{ kind: 0x30, body: [0x01] }] },
      new Uint8Array(ML_DSA_65_SIGNATURE_LEN).fill(0x55),
      new Uint8Array(ML_DSA_65_PUBLIC_KEY_LEN).fill(0x66),
    );
    // Tail groups: extensions-len(1) | ext kind 0x30 | body-len(1) | body 0x01 |
    // signature opaque variant tag = 0 (ML-DSA-65). Previously baked in the
    // buggy variant 3; corrected to 0 to match the Rust wire order (#43).
    expect(bytesToHex(wire)).toContain("000000000000000001000000000000003001000000000000000100000000");
  });

  it("matches the Rust MRV native transaction golden vector", () => {
    const signingPreimage = encodeTransactionForHash(MRV_NATIVE_TX_VECTOR.fields, 0x01);
    const identityPreimage = encodeTransactionForHash(MRV_NATIVE_TX_VECTOR.fields, 0x02);
    const signature = new Uint8Array(ML_DSA_65_SIGNATURE_LEN).fill(0x55);
    const publicKey = new Uint8Array(ML_DSA_65_PUBLIC_KEY_LEN).fill(0x66);
    const wire = bincodeSignedTransaction(MRV_NATIVE_TX_VECTOR.fields, signature, publicKey);
    const identityHash = keccak_256(new Uint8Array([...identityPreimage, ...signature, ...publicKey]));

    expect(bytesToHex(signingPreimage)).toBe(MRV_NATIVE_TX_VECTOR.signingPreimage);
    expect(bytesToHex(keccak_256(signingPreimage))).toBe(MRV_NATIVE_TX_VECTOR.sighash);
    expect(bytesToHex(identityHash)).toBe(MRV_NATIVE_TX_VECTOR.identityTxHash);
    expect(wire).toHaveLength(MRV_NATIVE_TX_VECTOR.wireLen);
    expect(bytesToHex(wire.slice(0, 160))).toBe(MRV_NATIVE_TX_VECTOR.wirePrefix);
    expect(bytesToHex(wire.slice(-80))).toBe(MRV_NATIVE_TX_VECTOR.wireSuffix);
  });

  it("writes ML-DSA-65 at bincode wire variant 0 in the signed-tx witness (regression: #43)", () => {
    // ML-DSA-65 is variant 0 in the Rust `PublicKey`/`Signature` enums; a stale
    // 3 decodes as Falcon1024 and fails closed with PqNotImplemented, so no
    // TS-produced transaction can be admitted. The golden prefix/suffix above
    // do NOT cover the two opaque variant tags, so this asserts them directly.
    expect(ENUM_VARIANT_INDEX_ML_DSA_65).toBe(0);
    const wire = bincodeSignedTransaction(
      MRV_NATIVE_TX_VECTOR.fields,
      new Uint8Array(ML_DSA_65_SIGNATURE_LEN).fill(0x55),
      new Uint8Array(ML_DSA_65_PUBLIC_KEY_LEN).fill(0x66),
    );
    const OPAQUE_HEADER = 4 + 2 + 8; // u32 variant | u16 algo id | u64 byte-len
    const pkStart = wire.length - (OPAQUE_HEADER + ML_DSA_65_PUBLIC_KEY_LEN);
    const sigStart = pkStart - (OPAQUE_HEADER + ML_DSA_65_SIGNATURE_LEN);
    const u32le = (a: Uint8Array, o: number) =>
      (a[o] | (a[o + 1] << 8) | (a[o + 2] << 16) | (a[o + 3] << 24)) >>> 0;
    expect(u32le(wire, sigStart)).toBe(0); // signature opaque variant tag
    expect(u32le(wire, pkStart)).toBe(0); // public-key opaque variant tag
    // the StandardAlgo id (MlDsa65 = 1001) still follows each variant tag
    expect(wire[sigStart + 4] | (wire[sigStart + 5] << 8)).toBe(STANDARD_ALGO_NUMBER_ML_DSA_65);
    expect(wire[pkStart + 4] | (wire[pkStart + 5] << 8)).toBe(STANDARD_ALGO_NUMBER_ML_DSA_65);
  });

});
