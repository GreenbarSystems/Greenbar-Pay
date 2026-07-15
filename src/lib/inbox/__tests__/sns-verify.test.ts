import { generateKeyPairSync, createSign } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  parseSnsEnvelope,
  buildCanonicalString,
  verifySnsSignature,
  type SnsEnvelope,
} from "../sns-verify";

// One key pair for all tests — RSA 2048 is the same algorithm SNS uses.
// crypto.createVerify().verify() accepts a raw SPKI public key PEM, which
// is what SNS returns from its SigningCertURL endpoint.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const TRUSTED_URL =
  "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem";

function makeEnvelope(overrides: Partial<SnsEnvelope> = {}): SnsEnvelope {
  const base: SnsEnvelope = {
    Type: "Notification",
    MessageId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    TopicArn: "arn:aws:sns:us-east-1:123456789012:ap-inbox",
    Message: '{"Records":[]}',
    Timestamp: "2026-07-15T12:00:00.000Z",
    SignatureVersion: "1",
    SigningCertURL: TRUSTED_URL,
    Signature: "",
    ...overrides,
  };
  // Sign the canonical string so the signature is always valid unless the
  // test is explicitly crafting an invalid one.
  if (!overrides.Signature) {
    const canonical = buildCanonicalString(base);
    const algo = base.SignatureVersion === "2" ? "SHA256" : "SHA1";
    const signer = createSign(algo);
    signer.update(canonical);
    base.Signature = signer.sign(privateKey, "base64");
  }
  return base;
}

// Returns the public key PEM as if fetched from SigningCertURL.
const mockFetchCert = async (_url: string): Promise<string> =>
  publicKey as string;

// Returns a different key so signatures won't verify.
const wrongKeyPair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const mockFetchWrongCert = async (_url: string): Promise<string> =>
  wrongKeyPair.publicKey as string;

describe("parseSnsEnvelope", () => {
  it("returns null for non-objects", () => {
    expect(parseSnsEnvelope(null)).toBeNull();
    expect(parseSnsEnvelope("string")).toBeNull();
    expect(parseSnsEnvelope(42)).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    expect(parseSnsEnvelope({})).toBeNull();
    expect(parseSnsEnvelope({ Type: "Notification" })).toBeNull();
  });

  it("returns null for unsupported Type values", () => {
    const raw = {
      Type: "Lambda",
      MessageId: "x",
      TopicArn: "x",
      Message: "x",
      Timestamp: "x",
      SignatureVersion: "1",
      Signature: "x",
      SigningCertURL: TRUSTED_URL,
    };
    expect(parseSnsEnvelope(raw)).toBeNull();
  });

  it("returns null for unsupported SignatureVersion", () => {
    const raw = {
      Type: "Notification",
      MessageId: "x",
      TopicArn: "x",
      Message: "x",
      Timestamp: "x",
      SignatureVersion: "3",
      Signature: "x",
      SigningCertURL: TRUSTED_URL,
    };
    expect(parseSnsEnvelope(raw)).toBeNull();
  });

  it("parses a valid Notification envelope", () => {
    const raw = {
      Type: "Notification",
      MessageId: "abc",
      TopicArn: "arn:aws:sns:us-east-1:123:test",
      Message: "hello",
      Timestamp: "2026-01-01T00:00:00.000Z",
      SignatureVersion: "1",
      Signature: "sig",
      SigningCertURL: TRUSTED_URL,
      Subject: "the subject",
    };
    const env = parseSnsEnvelope(raw);
    expect(env).not.toBeNull();
    expect(env!.Subject).toBe("the subject");
  });

  it("parses SubscriptionConfirmation with Token and SubscribeURL", () => {
    const raw = {
      Type: "SubscriptionConfirmation",
      MessageId: "abc",
      TopicArn: "arn:aws:sns:us-east-1:123:test",
      Message: "msg",
      Timestamp: "2026-01-01T00:00:00.000Z",
      SignatureVersion: "1",
      Signature: "sig",
      SigningCertURL: TRUSTED_URL,
      Token: "tok",
      SubscribeURL: "https://example.com/subscribe",
    };
    const env = parseSnsEnvelope(raw);
    expect(env).not.toBeNull();
    expect(env!.Token).toBe("tok");
    expect(env!.SubscribeURL).toBe("https://example.com/subscribe");
  });
});

describe("buildCanonicalString", () => {
  it("Notification: includes Message, MessageId, Timestamp, TopicArn, Type — no Subject when absent", () => {
    const env = makeEnvelope();
    const s = buildCanonicalString(env);
    expect(s).toContain("Message\n");
    expect(s).toContain("MessageId\n");
    expect(s).toContain("Timestamp\n");
    expect(s).toContain("TopicArn\n");
    expect(s).toContain("Type\n");
    expect(s).not.toContain("Subject\n");
  });

  it("Notification: includes Subject when present", () => {
    const env = makeEnvelope({ Subject: "Invoice arrived" });
    expect(buildCanonicalString(env)).toContain("Subject\nInvoice arrived\n");
  });

  it("Notification: does not include SubscribeURL or Token", () => {
    const s = buildCanonicalString(makeEnvelope());
    expect(s).not.toContain("SubscribeURL\n");
    expect(s).not.toContain("Token\n");
  });

  it("SubscriptionConfirmation: includes SubscribeURL and Token, not Subject", () => {
    const env = makeEnvelope({
      Type: "SubscriptionConfirmation",
      Token: "tok123",
      SubscribeURL: "https://sns.us-east-1.amazonaws.com/subscribe?...",
    });
    const s = buildCanonicalString(env);
    expect(s).toContain("SubscribeURL\n");
    expect(s).toContain("Token\ntok123\n");
    expect(s).not.toContain("Subject\n");
  });

  it("each key-value pair is terminated by \\n", () => {
    const env = makeEnvelope();
    const s = buildCanonicalString(env);
    // Every line (key or value) ends with \n — split on \n and last part is empty
    const lines = s.split("\n");
    expect(lines[lines.length - 1]).toBe("");
  });
});

describe("verifySnsSignature", () => {
  it("accepts a valid SHA1 signature (SignatureVersion 1)", async () => {
    const env = makeEnvelope({ SignatureVersion: "1" });
    await expect(verifySnsSignature(env, mockFetchCert)).resolves.toBeUndefined();
  });

  it("accepts a valid SHA256 signature (SignatureVersion 2)", async () => {
    const env = makeEnvelope({ SignatureVersion: "2" });
    await expect(verifySnsSignature(env, mockFetchCert)).resolves.toBeUndefined();
  });

  it("accepts a Notification with a Subject field", async () => {
    const env = makeEnvelope({ Subject: "Invoice from Acme" });
    await expect(verifySnsSignature(env, mockFetchCert)).resolves.toBeUndefined();
  });

  it("rejects when SigningCertURL is not from amazonaws.com", async () => {
    const env = makeEnvelope({
      SigningCertURL: "https://attacker.example.com/cert.pem",
    });
    await expect(verifySnsSignature(env, mockFetchCert)).rejects.toThrow(
      "not from a trusted AWS domain",
    );
  });

  it("rejects when SigningCertURL uses http (not https)", async () => {
    const env = makeEnvelope({
      SigningCertURL: "http://sns.us-east-1.amazonaws.com/cert.pem",
    });
    await expect(verifySnsSignature(env, mockFetchCert)).rejects.toThrow(
      "not from a trusted AWS domain",
    );
  });

  it("accepts CN (China) region certificate URLs", async () => {
    const env = makeEnvelope({
      SigningCertURL:
        "https://sns.cn-north-1.amazonaws.com.cn/SimpleNotificationService-test.pem",
    });
    await expect(verifySnsSignature(env, mockFetchCert)).resolves.toBeUndefined();
  });

  it("rejects a tampered message body (signature mismatch)", async () => {
    const env = makeEnvelope();
    // Tamper with the Message after signing
    env.Message = '{"Records":[],"injected":"payload"}';
    await expect(verifySnsSignature(env, mockFetchCert)).rejects.toThrow(
      "signature verification failed",
    );
  });

  it("rejects when the certificate is from a different key pair", async () => {
    const env = makeEnvelope();
    await expect(verifySnsSignature(env, mockFetchWrongCert)).rejects.toThrow(
      "signature verification failed",
    );
  });

  it("rejects a completely fabricated signature", async () => {
    const env = makeEnvelope({ Signature: "aGVsbG8=" });
    await expect(verifySnsSignature(env, mockFetchCert)).rejects.toThrow(
      "signature verification failed",
    );
  });

  it("propagates cert-fetch errors", async () => {
    const env = makeEnvelope();
    const failFetch = async (_url: string): Promise<string> => {
      throw new Error("network timeout");
    };
    await expect(verifySnsSignature(env, failFetch)).rejects.toThrow("network timeout");
  });
});
